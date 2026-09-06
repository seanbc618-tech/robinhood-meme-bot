#!/usr/bin/env python3
"""Pons event observer and offline exit planner. No signing or transaction sending."""
import argparse
import json
import os
import sqlite3
import ssl
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

RPC = "https://rpc.mainnet.chain.robinhood.com"
# Source: https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/
# Source-documented addresses; deployed bytecode observed, source audit pending.
FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"
HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"
EVENTS = {
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607": (FACTORY, "TokenLaunched", 4, 3),
    "0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4": (FACTORY, "LaunchSwept", 2, 2),
    "0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259": (FACTORY, "PoolGraduated", 2, 3),
    "0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573": (HOOK, "PoolRegistered", 2, 3),
}


def emit(value):
    print(json.dumps(value, ensure_ascii=False, default=str), flush=True)


def rpc(url, method, params):
    if method == 'eth_getLogs':
        url = RPC  # Alchemy free endpoint currently rejects ranges above 10 blocks.
    # Python.org's macOS Python may lack a configured CA bundle; keep TLS verified.
    cafile = os.environ.get("SSL_CERT_FILE")
    if not cafile and Path("/etc/ssl/cert.pem").is_file():
        cafile = "/etc/ssl/cert.pem"
    request = urllib.request.Request(url, json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    }).encode(), {"Content-Type": "application/json", "User-Agent": "rh-dog-bot/0.1"})
    with urllib.request.urlopen(request, timeout=20,
                                context=ssl.create_default_context(cafile=cafile)) as response:
        result = json.load(response)
    if "error" in result or result.get("result") is None:
        raise RuntimeError(f"SOURCE_UNAVAILABLE: {method}: {result.get('error')}")
    return result["result"]


def address(word):
    if len(word) != 64 or word[:24] != "0" * 24:
        raise ValueError("Invalid ABI address word")
    int(word, 16)
    return "0x" + word[24:].lower()


def decode(log):
    emitter, name, topic_count, word_count = EVENTS[log["topics"][0].lower()]
    topics = log["topics"]
    data = log["data"][2:]
    if log["address"].lower() != emitter or len(topics) != topic_count or len(data) != 64 * word_count:
        raise ValueError("Event emitter/layout mismatch; refusing to infer fields")
    words = [data[i:i + 64] for i in range(0, len(data), 64)]
    token = address(words[0] if name == "PoolRegistered" else topics[1][2:])
    result = {"event": name, "token": token, "status": "OBSERVED_ONLY",
              "buy_allowed": False, "sell_simulation": None, "hotness": None}
    if name == "TokenLaunched":
        result.update(curve=address(topics[2][2:]), deployer=address(topics[3][2:]),
                      quote_token=address(words[0]))
    elif name == "PoolRegistered":
        result.update(pool_id=topics[1], quote_token=address(words[1]))
    return result


def scan(args):
    if int(rpc(args.rpc, "eth_chainId", []), 16) != 4663:
        raise RuntimeError("Wrong chain; expected 4663")
    for contract in (FACTORY, HOOK):
        if rpc(args.rpc, "eth_getCode", [contract, "latest"]) == "0x":
            raise RuntimeError(f"No deployed contract: {contract}")
    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.db) as db:
        db.execute("CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), block INTEGER, hash TEXT)")
        db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, block INTEGER, observed_at INTEGER, decoded TEXT, raw TEXT)")
        while True:
            latest = rpc(args.rpc, "eth_getBlockByNumber", ["latest", False])
            age = int(time.time()) - int(latest["timestamp"], 16)
            if not -30 <= age <= 120:
                raise RuntimeError(f"SOURCE_STALE: latest block age={age}s")
            head = int(latest["number"], 16)
            end = max(0, head - 64)  # Confirmation delay, NOT Ethereum finality.
            previous = db.execute("SELECT block, hash FROM cursor WHERE id=1").fetchone()
            if previous:
                if args.from_block is not None:
                    raise ValueError("--from-block requires a fresh database")
                checkpoint = rpc(args.rpc, "eth_getBlockByNumber", [hex(previous[0]), False])
                if checkpoint["hash"] != previous[1]:
                    raise RuntimeError("REORG: saved checkpoint changed; stop for reconciliation")
                start = previous[0] + 1
            else:
                start = args.from_block if args.from_block is not None else max(0, end - 999)
            stop = min(end, start + 9999)
            count = 0
            for low in range(start, stop + 1, 1000):
                high = min(low + 999, stop)
                anchor = rpc(args.rpc, "eth_getBlockByNumber", [hex(high), False])
                logs = rpc(args.rpc, "eth_getLogs", [{"fromBlock": hex(low), "toBlock": hex(high),
                           "address": [FACTORY, HOOK], "topics": [list(EVENTS)]}])
                records = []
                for log in logs:
                    block = int(log["blockNumber"], 16)
                    if log.get("removed") or not low <= block <= high:
                        raise RuntimeError("Inconsistent log range or removed log")
                    decoded = decode(log)
                    identity = log["blockHash"] + ":" + log["transactionHash"] + ":" + log["logIndex"]
                    records.append((identity, block, int(time.time()), json.dumps(decoded), json.dumps(log)))
                if rpc(args.rpc, "eth_getBlockByNumber", [hex(high), False])["hash"] != anchor["hash"]:
                    raise RuntimeError("REORG during scan; no cursor advance")
                with db:
                    db.executemany("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)", records)
                    db.execute("INSERT OR REPLACE INTO cursor VALUES (1, ?, ?)", (high, anchor["hash"]))
                for record in records:
                    emit({**json.loads(record[3]), "block": record[1], "event_id": record[0]})
                count += len(records)
            emit({"mode": "observe", "from_block": start, "through_block": stop,
                  "head": head, "events_in_range": count, "backlog_blocks": max(0, end - stop),
                  "status": "SCANNED" if start <= stop else "NO_NEW_BLOCKS",
                  "coverage": "bounded range only; absence of events is not absence of launches"})
            if not args.watch:
                return
            args.from_block = None
            time.sleep(args.interval)


def number(data, key):
    value = Decimal(str(data[key]))
    if not value.is_finite() or value < 0:
        raise ValueError(f"{key} must be finite and nonnegative")
    return value


def plan(data, recover_multiple, half_multiple):
    """Stateless draft only. Input fills must be confirmed; never mark an intent filled."""
    equity = number(data, "equity_usd")  # Includes reserved cash; excludes withdrawals.
    withdrawn = number(data, "withdrawn_usd")
    cash = number(data, "cash_usd")  # Includes the untouched $200 reserve.
    if cash > equity:
        raise ValueError("cash_usd exceeds equity_usd")
    loss = max(Decimal(0), Decimal(1000) - equity - withdrawn)
    halted = data["halted"]
    if not isinstance(halted, bool):
        raise ValueError("halted must be boolean")
    halted = halted or loss >= 800
    result = {"mode": "OFFLINE_PLAN_NOT_ORDERS", "net_loss_usd": loss, "halted": halted,
              "new_buy_budget_usd": Decimal(0) if halted else min(Decimal(30), max(Decimal(0), cash - 200)),
              "action": "STOP_NEW_BUYS_AND_REVIEW_EXITS" if halted else "NO_ENTRY_SIGNAL",
              "exits": []}
    for position in data["positions"]:
        token = position["token"]
        qty = number(position, "remaining_qty")
        if qty == 0:
            continue
        cost = number(position, "entry_cost_usd")
        initial_qty = number(position, "initial_qty")
        proceeds = number(position, "confirmed_net_sale_proceeds_usd")
        if cost == 0 or initial_qty == 0 or qty > initial_qty:
            raise ValueError("Invalid position cost or quantity")
        if not isinstance(position["half_sale_confirmed"], bool):
            raise ValueError("half_sale_confirmed must be boolean")
        missing = [k for k in ("reference_price_usd", "estimated_exit_fee_usd", "price_timestamp")
                   if position.get(k) is None]
        if missing:
            result["exits"].append({"token": token, "action": "DATA_MISSING", "missing": missing})
            continue
        price = number(position, "reference_price_usd")
        fee = number(position, "estimated_exit_fee_usd")
        age = Decimal(str(time.time())) - number(position, "price_timestamp")
        if not 0 <= age <= 60 or price == 0:
            result["exits"].append({"token": token, "action": "STALE_OR_ZERO_PRICE"})
            continue
        multiple = price * initial_qty / cost
        item = {"token": token, "reference_multiple": multiple, "action": "HOLD"}
        if halted:
            item.update(action="REQUOTE_EXIT_ALL", indicative_qty=qty)
        elif proceeds < cost and multiple >= recover_multiple:
            # Only an estimate. Size-specific V4 quote and costs required before an order.
            item.update(action="REQUOTE_RECOVER_COST", indicative_qty=min(qty, (cost - proceeds + fee) / price))
        elif proceeds >= cost and multiple >= half_multiple and not position["half_sale_confirmed"]:
            item.update(action="REQUOTE_SELL_HALF_REMAINING", indicative_qty=qty / 2)
        result["exits"].append(item)
    return result


def main():
    settings = Path(__file__).parent / '.env.rpc'
    if settings.exists():
        for line in settings.read_text().splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip() == 'ROBINHOOD_RPC_URL':
                os.environ.setdefault('ROBINHOOD_RPC_URL', value.strip())
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    observer = commands.add_parser("scan", help="Read real Pons events into local SQLite")
    observer.add_argument("--rpc", default=os.environ.get("ROBINHOOD_RPC_URL", RPC))
    observer.add_argument("--db", default=str(Path(__file__).parent / "data/events.sqlite"))
    observer.add_argument("--from-block", type=int)
    observer.add_argument("--watch", action="store_true")
    observer.add_argument("--interval", type=int, default=15)
    planner = commands.add_parser("plan", help="Calculate an offline exit draft, never a fill")
    planner.add_argument("snapshot", type=Path)
    planner.add_argument("--recover-at", type=Decimal, default=Decimal(2))
    planner.add_argument("--half-at", type=Decimal, default=Decimal(10))
    args = parser.parse_args()
    if args.command == "scan":
        if args.interval < 1 or (args.from_block is not None and args.from_block < 0):
            parser.error("interval must be positive; from-block must be nonnegative")
        scan(args)
    else:
        if not (args.recover_at.is_finite() and args.half_at.is_finite()
                and 1 < args.recover_at < args.half_at and 10 <= args.half_at <= 20):
            parser.error("require 1 < recover-at < half-at and half-at within [10, 20]")
        emit(plan(json.loads(args.snapshot.read_text()), args.recover_at, args.half_at))


if __name__ == "__main__":
    main()
