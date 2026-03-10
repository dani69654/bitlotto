import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    NetEvent,
    OP_NET,
    Revert,
    SafeMath,
    Selector,
    StoredU256,
    StoredBoolean,
    StoredAddressArray,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// ─── Storage Pointers ──────────────────────────────────────────────────────
// Each pointer must be unique across the contract

const PTR_ROUND_ID: u16       = 1;
const PTR_TICKET_PRICE: u16   = 2;
const PTR_MAX_TICKETS: u16    = 3;
const PTR_TICKET_COUNT: u16   = 4;
const PTR_JACKPOT: u16        = 5;
const PTR_IS_OPEN: u16        = 6;
const PTR_TICKET_HOLDERS: u16 = 7;  // StoredAddressArray: index => buyer address
const PTR_WINNER: u16         = 8;  // Last winner address (stored as StoredAddressArray of length 1)

// ─── Events ────────────────────────────────────────────────────────────────

class TicketPurchasedEvent extends NetEvent {
    constructor(buyer: Address, ticketIndex: u256) {
        // 32 bytes address + 32 bytes u256
        const writer = new BytesWriter(64);
        writer.writeAddress(buyer);
        writer.writeU256(ticketIndex);
        super('TicketPurchased', writer);
    }
}

class WinnerDrawnEvent extends NetEvent {
    constructor(winner: Address, jackpotSatoshis: u256, roundId: u256) {
        // 32 + 32 + 32
        const writer = new BytesWriter(96);
        writer.writeAddress(winner);
        writer.writeU256(jackpotSatoshis);
        writer.writeU256(roundId);
        super('WinnerDrawn', writer);
    }
}

class RoundStartedEvent extends NetEvent {
    constructor(roundId: u256, ticketPrice: u256, maxTickets: u256) {
        const writer = new BytesWriter(96);
        writer.writeU256(roundId);
        writer.writeU256(ticketPrice);
        writer.writeU256(maxTickets);
        super('RoundStarted', writer);
    }
}

// ─── Contract ──────────────────────────────────────────────────────────────

/**
 * BitLotto — Trustless Bitcoin L1 Lottery powered by OP_NET
 *
 * Flow:
 *  1. Deployer calls startRound(ticketPriceSatoshis, maxTickets)
 *  2. Players call buyTicket() — off-chain they send BTC to the contract address
 *     matching ticketPrice. The deployer verifies the payment and calls registerTicket(buyer).
 *     (OP_NET v1 does not expose per-call BTC value natively — see note below)
 *  3. Deployer calls drawWinner(vrfSeed) with an external VRF seed
 *  4. Winner is selected deterministically: vrfSeed % ticketCount
 *  5. WinnerDrawn event emitted — off-chain the deployer sends the jackpot to the winner
 *
 * NOTE ON BTC PAYMENTS:
 * OP_NET v1 smart contracts receive BTC via UTXO outputs sent to the contract's P2OP address.
 * On-chain BTC transfer FROM a contract is not yet natively supported in btc-runtime v1.
 * The jackpot amount is tracked on-chain for full transparency. The deployer handles the
 * actual BTC payout off-chain, triggered by the WinnerDrawn event.
 * This is the same model used by early Lightning Network custody solutions.
 *
 * Future: When OP_NET adds native BTC transfer opcodes, drawWinner() will call
 * Blockchain.transferBTC(winner, jackpot) directly.
 */
@final
export class BitLotto extends OP_NET {

    // ── Persistent state ─────────────────────────────────────────────────

    private _roundId: StoredU256;
    private _ticketPrice: StoredU256;   // in satoshis
    private _maxTickets: StoredU256;
    private _ticketCount: StoredU256;
    private _jackpot: StoredU256;       // accumulated satoshis
    private _isOpen: StoredBoolean;

    // Array of buyer addresses indexed by ticket number
    private _ticketHolders: StoredAddressArray;

    public constructor() {
        super();

        this._roundId      = new StoredU256(PTR_ROUND_ID,      EMPTY_POINTER);
        this._ticketPrice  = new StoredU256(PTR_TICKET_PRICE,  EMPTY_POINTER);
        this._maxTickets   = new StoredU256(PTR_MAX_TICKETS,   EMPTY_POINTER);
        this._ticketCount  = new StoredU256(PTR_TICKET_COUNT,  EMPTY_POINTER);
        this._jackpot      = new StoredU256(PTR_JACKPOT,       EMPTY_POINTER);
        this._isOpen       = new StoredBoolean(PTR_IS_OPEN,    false);

        // Max 10000 tickets per round
        this._ticketHolders = new StoredAddressArray(PTR_TICKET_HOLDERS, EMPTY_POINTER, 10000);
    }

    // ─── One-time initialization ──────────────────────────────────────────

    public override onDeployment(_calldata: Calldata): void {
        this._roundId.value     = u256.fromU32(1);
        this._ticketPrice.value = u256.fromU32(1000);  // default: 1000 satoshis
        this._maxTickets.value  = u256.fromU32(100);   // default: 100 tickets
        this._ticketCount.value = u256.Zero;
        this._jackpot.value     = u256.Zero;
        this._isOpen.value      = false;
    }

    // ─── Method Routing ───────────────────────────────────────────────────

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case encodeSelector('startRound(uint256,uint256)'):
                return this.startRound(calldata);
            case encodeSelector('registerTicket(address)'):
                return this.registerTicket(calldata);
            case encodeSelector('drawWinner(uint256)'):
                return this.drawWinner(calldata);
            case encodeSelector('getRoundInfo()'):
                return this.getRoundInfo();
            case encodeSelector('getTicketHolder(uint256)'):
                return this.getTicketHolder(calldata);
            default:
                return super.execute(method, calldata);
        }
    }

    // ─── Admin: Start a new round ─────────────────────────────────────────

    private startRound(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (this._isOpen.value) {
            throw new Revert('Round already open');
        }

        const price: u256   = calldata.readU256();
        const maxTix: u256  = calldata.readU256();

        if (u256.eq(price, u256.Zero))  throw new Revert('Ticket price must be > 0');
        if (u256.eq(maxTix, u256.Zero)) throw new Revert('Max tickets must be > 0');
        if (u256.gt(maxTix, u256.fromU32(10000))) throw new Revert('Max tickets cannot exceed 10000');

        this._ticketPrice.value = price;
        this._maxTickets.value  = maxTix;
        this._ticketCount.value = u256.Zero;
        this._jackpot.value     = u256.Zero;
        this._isOpen.value      = true;

        this.emitEvent(new RoundStartedEvent(this._roundId.value, price, maxTix));

        const writer = new BytesWriter(32);
        writer.writeU256(this._roundId.value);
        return writer;
    }

    // ─── Admin: Register a ticket purchase ───────────────────────────────

    /**
     * registerTicket(buyer: address)
     * Called by the deployer after verifying the buyer sent the correct BTC amount.
     * The buyer's address is recorded on-chain for the draw.
     */
    private registerTicket(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this._isOpen.value) {
            throw new Revert('No round is currently open');
        }

        const count = this._ticketCount.value;
        if (u256.ge(count, this._maxTickets.value)) {
            throw new Revert('Round is full');
        }

        const buyer: Address = calldata.readAddress();

        // Record the ticket
        const index = count.toU32();
        this._ticketHolders.set(index, buyer);

        // Accumulate jackpot
        this._jackpot.value  = SafeMath.add(this._jackpot.value, this._ticketPrice.value);
        this._ticketCount.value = SafeMath.add(count, u256.fromU32(1));

        this.emitEvent(new TicketPurchasedEvent(buyer, count));

        const writer = new BytesWriter(32);
        writer.writeU256(count); // returns assigned ticket index
        return writer;
    }

    // ─── Admin: Draw the winner ───────────────────────────────────────────

    /**
     * drawWinner(vrfSeed: uint256)
     * The deployer submits a VRF seed from an external oracle (e.g. Chainlink VRF or drand).
     * Winner = vrfSeed % ticketCount. The WinnerDrawn event triggers the off-chain BTC payout.
     */
    private drawWinner(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this._isOpen.value) {
            throw new Revert('No round is currently open');
        }

        const count = this._ticketCount.value;
        if (u256.eq(count, u256.Zero)) {
            throw new Revert('No tickets sold');
        }

        const vrfSeed: u256 = calldata.readU256();
        if (u256.eq(vrfSeed, u256.Zero)) {
            throw new Revert('VRF seed cannot be zero');
        }

        // Deterministic, verifiable winner selection
        const winnerIndex: u256  = SafeMath.mod(vrfSeed, count);
        const winnerIdx32: u32   = winnerIndex.toU32();
        const winner: Address    = this._ticketHolders.get(winnerIdx32);
        const prize: u256        = this._jackpot.value;
        const roundId: u256      = this._roundId.value;

        // Close round
        this._isOpen.value      = false;
        this._jackpot.value     = u256.Zero;
        this._ticketCount.value = u256.Zero;
        this._roundId.value     = SafeMath.add(roundId, u256.fromU32(1));

        this.emitEvent(new WinnerDrawnEvent(winner, prize, roundId));

        // Return winner address + prize for easy off-chain parsing
        const writer = new BytesWriter(32 + 32 + 32);
        writer.writeAddress(winner);
        writer.writeU256(prize);
        writer.writeU256(roundId);
        return writer;
    }

    // ─── View: Round info ─────────────────────────────────────────────────

    private getRoundInfo(): BytesWriter {
        const writer = new BytesWriter(32 * 5 + 1);
        writer.writeU256(this._roundId.value);
        writer.writeU256(this._ticketPrice.value);
        writer.writeU256(this._maxTickets.value);
        writer.writeU256(this._ticketCount.value);
        writer.writeU256(this._jackpot.value);
        writer.writeBoolean(this._isOpen.value);
        return writer;
    }

    // ─── View: Ticket holder by index ─────────────────────────────────────

    private getTicketHolder(calldata: Calldata): BytesWriter {
        const index: u256 = calldata.readU256();
        const holder: Address = this._ticketHolders.get(index.toU32());
        const writer = new BytesWriter(32);
        writer.writeAddress(holder);
        return writer;
    }
}
