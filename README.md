# 🎰 BitLotto

**Trustless Bitcoin L1 Lottery powered by OP_NET**

BitLotto is an on-chain lottery running directly on Bitcoin Layer 1 via the OP_NET smart contract protocol. Players buy tickets, a verifiable random function (VRF) selects the winner, and the entire jackpot is paid out in BTC. No trusted intermediary, no custodian — just Bitcoin.

---

## How It Works

1. **Deployer opens a round** — sets ticket price (in satoshis) and max number of tickets
2. **Players buy tickets** — send BTC to the contract's P2OP address; the deployer registers each purchase on-chain
3. **Round closes** — when tickets sell out or the deployer closes manually
4. **VRF draw** — deployer submits a seed from an external VRF oracle (e.g. [drand](https://drand.love/))
5. **Winner selected** — deterministically computed on-chain as `vrfSeed % ticketCount`
6. **Jackpot paid** — winner receives the full accumulated jackpot in BTC

All ticket registrations, round state, and winner draws are permanently recorded on Bitcoin L1 and verifiable by anyone.

---

## Smart Contract

Written in **AssemblyScript**, compiled to **WebAssembly**, deployed on **OP_NET**.

### Methods

| Method | Access | Description |
|--------|--------|-------------|
| `startRound(ticketPrice, maxTickets)` | Deployer | Opens a new lottery round |
| `registerTicket(buyer)` | Deployer | Records a ticket purchase on-chain |
| `drawWinner(vrfSeed)` | Deployer | Selects winner and closes the round |
| `getRoundInfo()` | Public | Returns current round state |
| `getTicketHolder(index)` | Public | Returns the address at a given ticket index |

### Events

| Event | Data |
|-------|------|
| `RoundStarted` | roundId, ticketPrice, maxTickets |
| `TicketPurchased` | buyer address, ticket index |
| `WinnerDrawn` | winner address, jackpot (satoshis), roundId |

### Storage

- `roundId` — current round number
- `ticketPrice` — price per ticket in satoshis
- `maxTickets` — maximum tickets per round
- `ticketCount` — tickets sold so far
- `jackpot` — accumulated satoshis in the prize pool
- `isOpen` — whether a round is currently active
- `ticketHolders[]` — on-chain array mapping ticket index → buyer address

---

## Architecture

```
Bitcoin L1 (OP_NET)
└── BitLotto.wasm              ← Smart contract (AssemblyScript → WASM)
    ├── startRound()           ← Admin: opens round
    ├── registerTicket()       ← Admin: records BTC payment
    ├── drawWinner(vrfSeed)    ← Admin: VRF-based selection
    └── getRoundInfo()         ← Public: read state

Frontend (React + Vite)
└── OP_WALLET integration      ← Connect wallet, view rounds, track tickets

Off-chain Operator
└── Monitors BTC payments to contract address
└── Calls registerTicket() for verified purchases
└── Fetches VRF seed from drand and calls drawWinner()
└── Sends jackpot BTC to winner address
```

> **Note on BTC payouts:** OP_NET v1 does not yet support native BTC transfers *from* a contract. The jackpot amount is tracked and verified fully on-chain via the `WinnerDrawn` event. The operator executes the payout off-chain, signing a standard Bitcoin transaction to the winner's address. This is the same trust model used by early Lightning Network node operators — the on-chain record is the source of truth.

---

## Tech Stack

- **Smart Contract:** AssemblyScript → WebAssembly (OP_NET runtime)
- **Protocol:** [OP_NET](https://opnet.org) — Bitcoin L1 smart contracts
- **Randomness:** [drand](https://drand.love/) — publicly verifiable distributed randomness
- **Frontend:** React + Vite + OP_WALLET SDK
- **Deploy:** Vercel

---

## Project Structure

```
bitlotto/
├── src/
│   └── lottery/
│       ├── BitLotto.ts        ← Smart contract
│       └── index.ts           ← OP_NET entry point
├── frontend/                  ← React app (coming soon)
├── build/
│   └── BitLotto.wasm          ← Compiled contract (gitignored)
├── asconfig.json
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- [OP_WALLET](https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb) Chrome extension

### Build the contract

```bash
git clone https://github.com/dani69654/bitlotto
cd bitlotto
npm install
npx asc src/lottery/index.ts --target lottery
# Output: build/BitLotto.wasm
```

### Deploy

1. Open OP_WALLET → switch to Regtest
2. Click **Deploy** → drag `build/BitLotto.wasm`
3. Confirm the transaction

### Run a round (Regtest)

```bash
# Get regtest BTC from the faucet
# https://faucet.opnet.org/

# Then interact via OP_WALLET or the frontend
```

---

## Randomness & Fairness

BitLotto uses [drand](https://drand.love/) as the VRF oracle — a publicly verifiable, bias-resistant distributed randomness beacon operated by a league of independent organizations (Cloudflare, EPFL, Protocol Labs, etc.).

The winner selection is fully deterministic and verifiable:

```
winnerIndex = vrfSeed % totalTicketsSold
winner = ticketHolders[winnerIndex]
```

Anyone can verify the draw by checking:
1. The `vrfSeed` submitted in the `drawWinner` transaction
2. The drand round corresponding to the block height
3. The `ticketHolders` array on-chain

---

## Built for the OP_NET Vibecode Challenge

This project is a submission to [vibecode.finance](https://vibecode.finance) — the Bitcoin L1 builders challenge powered by OP_NET.

**#opnetvibecode** | [@opnetbtc](https://x.com/opnetbtc)

---

## License

MIT
