#!/usr/bin/env python3
"""Prime Vision data analysis. Python 3 standard library only.
Usage:  python analyze.py pv-full.json [--month 2026-11] [--csv OUT_DIR]
Get pv-full.json from the admin panel: tab "تصدير وتحليل" > JSON.
Amounts are in SDG. Simple summaries, not an accounting or tax filing."""
import json, sys, csv, os, argparse
from collections import defaultdict

p = argparse.ArgumentParser()
p.add_argument("file")
p.add_argument("--month", default="", help="YYYY-MM filter for dated records")
p.add_argument("--csv", default="", help="folder to write CSV summaries")
a = p.parse_args()
D = json.load(open(a.file, encoding="utf-8"))
g = lambda k: D.get(k) or []
inm = lambda d: (not a.month) or str(d or "").startswith(a.month)
money = lambda x: f"{x:,.2f}"
out = {}

def table(title, rows, head):
    print("\n== " + title + " ==")
    if not rows:
        print("(no data)")
        return
    print(" | ".join(head))
    for r in rows:
        print(" | ".join(str(x) if not isinstance(x, float) else money(x) for x in r))
    out[title] = (head, rows)

E = [e for e in g("acc_entries") if inm(e.get("date"))]
sales = [e for e in E if e["type"] == "sale"]
purch = [e for e in E if e["type"] == "purchase"]
exps = [e for e in E if e["type"] == "expense"]
vat = lambda L: sum(e.get("vat") or 0 for e in L)
tot = lambda L: sum(e["amount"] for e in L)
print("Period:", a.month or "all")
sn, pn = tot(sales) - vat(sales), tot(purch) - vat(purch)
cexp = sum(c["amount"] for c in g("custx") if c["kind"] == "expense" and inm(c.get("date")))
table("Summary", [
    ["Sales (net of VAT)", sn], ["Purchases (net of VAT)", pn],
    ["Direct expenses", tot(exps)], ["Custody expenses", cexp],
    ["Result", sn - pn - tot(exps) - cexp],
    ["Output VAT", vat(sales)], ["Input VAT", vat(purch)], ["Net VAT due", vat(sales) - vat(purch)],
], ["Item", "SDG"])

m = defaultdict(float)
for e in sales: m[str(e["date"])[:7]] += e["amount"]
table("Sales by month", sorted(m.items()), ["Month", "SDG"])

c = defaultdict(float)
for e in sales: c[e.get("party") or "(no name)"] += e["amount"]
for o in g("orders"):
    if inm(o.get("created")) and o.get("status") == "مكتمل": c["[orders] " + (o.get("customer_name") or "")] += o.get("total") or 0
table("Top customers by sales", sorted(c.items(), key=lambda x: -x[1])[:15], ["Customer", "SDG"])

d = defaultdict(float)
for e in sales:
    r = e["amount"] - e["paid"]
    if r > 0: d[e.get("party") or "(no name)"] += r
table("Receivables (unpaid sales)", sorted(d.items(), key=lambda x: -x[1]), ["Customer", "SDG due"])
d = defaultdict(float)
for e in purch:
    r = e["amount"] - e["paid"]
    if r > 0: d[e.get("party") or "(no name)"] += r
table("Payables (unpaid purchases)", sorted(d.items(), key=lambda x: -x[1]), ["Supplier", "SDG due"])

x = defaultdict(float)
for e in exps: x[e.get("description") or e.get("party") or "(none)"] += e["amount"]
table("Expenses by description", sorted(x.items(), key=lambda x: -x[1]), ["Description", "SDG"])

R = [r for r in g("requests") if inm(r.get("created"))]
pc = defaultdict(int)
for r in R: pc[r.get("product") or "(none)"] += 1
table("Most requested products (site form)", sorted(pc.items(), key=lambda x: -x[1])[:10], ["Product", "Requests"])
sc = defaultdict(int)
for r in R: sc[r.get("status")] += 1
table("Requests by status", sorted(sc.items()), ["Status", "Count"])

P = g("products")
table("Low stock (3 or less, active)", [[p["name"], p["stock"]] for p in P if p.get("active") and p["stock"] <= 3], ["Product", "Stock"])
table("Inventory value at selling price (no cost data)", [["Total", sum((p.get("price") or 0) * p["stock"] for p in P if p.get("active"))]], ["Item", "SDG"])

bal = defaultdict(float)
for b in g("banks"): bal[b["name"]] = float(b.get("opening") or 0)
bn = {b["id"]: b["name"] for b in g("banks")}
for pm in g("acc_payments"):
    k = bn.get(pm.get("bank_id"), "Cash")
    bal[k] += pm["amount"] if pm["type"] == "sale" else -pm["amount"]
for t in g("banktx"):
    if t["kind"] == "deposit": bal[bn.get(t["bank_id"], "?")] += t["amount"]; bal["Cash"] -= t["amount"]
    elif t["kind"] == "withdraw": bal[bn.get(t["bank_id"], "?")] -= t["amount"]; bal["Cash"] += t["amount"]
    else: bal[bn.get(t["bank_id"], "?")] -= t["amount"]; bal[bn.get(t["to_bank_id"], "?")] += t["amount"]
for cx in g("custx"):
    k = bn.get(cx.get("bank_id"), "Cash")
    if cx["kind"] == "advance": bal[k] -= cx["amount"]
    elif cx["kind"] == "return": bal[k] += cx["amount"]
table("Cash and bank balances (now)", sorted(bal.items()), ["Account", "SDG"])

if a.csv:
    os.makedirs(a.csv, exist_ok=True)
    for title, (head, rows) in out.items():
        fn = "".join(ch if ch.isalnum() else "_" for ch in title)[:40] + ".csv"
        with open(os.path.join(a.csv, fn), "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f); w.writerow(head); w.writerows(rows)
    print("\nCSV written to", a.csv)
