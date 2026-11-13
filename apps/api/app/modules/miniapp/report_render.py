"""Portable report exports from one canonical snapshot; no browser or live URLs."""

import base64
import re
from decimal import ROUND_HALF_UP, Decimal
from html import escape
from io import BytesIO

from app.modules.bank.direct_posting import LABELS
from app.modules.bank.router import SPECIAL_TYPE_LABELS

FLOW_LABELS = {**SPECIAL_TYPE_LABELS, **LABELS}


def cash(value):
    if value is None:
        return "待录入"
    number = Decimal(str(value))
    return ("-" if number < 0 else "") + f"¥{abs(number):,.2f}"


def percent(value, total):
    if not total or float(total) <= 0:
        return "—"
    # Mirror shared JavaScript Number arithmetic and toFixed(2) tie handling.
    result = Decimal.from_float(float(value or 0) / float(total) * 100)
    return str(result.quantize(Decimal(".01"), rounding=ROUND_HALF_UP)) + "%"


def sections(snapshot):
    report, extra = snapshot["report"], snapshot["supplement"]
    m = report["metrics"]
    out = []

    def add(title, headers, rows, note=""):
        out.append({"title": title, "headers": headers, "rows": rows, "note": note})

    def metrics(title, pairs, note=""):
        add(
            title,
            ["指标", "金额 / 比例", "说明"],
            [[name, value, hint] for name, value, hint in pairs],
            note,
        )

    metrics(
        "门店营收",
        [
            ("营业收入", cash(m["income_amount"]), ""),
            ("本月业绩目标", cash(extra["revenue_target"]), ""),
            ("业绩完成率", percent(m["income_amount"], extra["revenue_target"]), ""),
            ("实收", cash(m["revenue_net_amount"]), ""),
            ("手续费", cash(m["fee_amount"]), ""),
            ("手续费率", percent(m["fee_amount"], m["income_amount"]), ""),
        ],
    )
    add(
        "各渠道经营收入明细",
        ["渠道", "经营收入", "实收", "手续费", "手续费率", "收入占比"],
        [
            [
                r["channel"],
                cash(r["gross_amount"]),
                cash(r["net_amount"]),
                cash(r["fee_amount"]),
                str(r["fee_rate"]) + "%",
                percent(r["gross_amount"], m["income_amount"]),
            ]
            for r in sorted(
                m["revenue_channel_summary"], key=lambda r: Decimal(r["gross_amount"]), reverse=True
            )
        ],
    )
    expense_metrics = [
        ("总支出", cash(m["expense_amount"]), ""),
        (
            "营业毛利率",
            percent(m["gross_profit_amount"], m["income_amount"]),
            "食材成本 " + cash(m["food_cost_amount"]),
        ),
        (
            "营运费用占比",
            percent(m["operation_expense_amount"], m["income_amount"]),
            "运营费用 " + cash(m["operation_expense_amount"]),
        ),
        (
            "薪资占比",
            percent(m["labor_cost_amount"], m["income_amount"]),
            "人工成本 " + cash(m["labor_cost_amount"]),
        ),
    ]
    totals = extra.get("accrual_totals", {})
    if any(Decimal(str(v)) for v in totals.values()):
        expense_metrics += [
            (name, cash(totals.get(kind, "0")), "已计入总支出，不重复累计")
            for name, kind in [
                ("本月计提", "accrual"),
                ("本月补提", "supplement"),
                ("本月冲销", "reversal"),
            ]
        ]
    metrics("门店支出", expense_metrics)
    balance = extra["bank_balance"]
    metrics(
        "资金流情况",
        [
            (
                "银行卡余额",
                cash(balance["amount"])
                if balance["status"] == "ready"
                else {"pending": "待到期", "missing_manual": "待录入"}.get(
                    balance["status"], "未录入余额基准"
                ),
                "截至 " + balance["date"] + " 余额",
            ),
            (
                "其他应收款 · 外借款",
                cash(extra.get("loan_receivable_amount", "0")),
                "截至本月末未归还本金，不计经营利润",
            ),
        ],
    )
    loans = extra.get("loan_receivables", [])
    add(
        "借还款明细",
        ["借款人", "借出本金", "累计归还", "未还本金", "状态"],
        [
            [l["borrower"], cash(l["amount"]), cash(l["repaid"]), cash(l["remaining"]), l["status"]]
            for l in loans
        ],
    )
    add(
        "借还款事件",
        ["借款人", "日期", "类型", "金额", "备注"],
        [
            [
                l["borrower"],
                e["date"],
                ("借出" if e["kind"] == "lend" else "还款")
                + ("（已撤销）" if e.get("active") is False else ""),
                cash(e["amount"]),
                e.get("remark", ""),
            ]
            for l in loans
            for e in l.get("events", [])
        ],
    )
    isolated = extra.get("dividend_excluded")
    metrics(
        "利润分红",
        [
            (
                "本月净利润",
                cash(Decimal(m["income_amount"]) - Decimal(m["expense_amount"])),
                "财务报表净利润",
            ),
            (
                "上月末未分配利润",
                "隔离前" if isolated else cash(extra.get("previous_remaining_undistributed")),
                "",
            ),
            (
                "剩余未分配利润",
                "隔离前" if isolated else cash(extra.get("remaining_undistributed")),
                "",
            ),
            ("本月分红", cash(extra["distribution_amount"]), ""),
            (
                "本月补充筹建超支",
                cash(extra.get("preopening_coverage_amount", "0")),
                "不计入股东分红",
            ),
            ("本月运营增资", cash(extra["capital_amount"]), ""),
            ("历史累计利润", cash(extra.get("historical_profit")), "截至本月"),
            ("历史累计分红", cash(extra["cumulative_distribution"]), "截至本月"),
        ],
    )
    balance_value = extra.get("preopening_balance")
    metrics(
        "投入与累计",
        [
            ("筹建投入资金", cash(extra["preopening_investment"]), ""),
            (
                "筹建费用总支出",
                cash(
                    None
                    if extra["preopening_expense_source"] == "missing"
                    else extra["preopening_expense_amount"]
                ),
                {"manual": "人工录入", "report": "已封账筹建报表", "missing": "筹建报表未封账"}.get(
                    extra["preopening_expense_source"], "待核对"
                ),
            ),
            (
                "筹建结余/超支"
                if balance_value is None
                else "筹建超支"
                if Decimal(balance_value) < 0
                else "筹建结余",
                "待计算" if balance_value is None else cash(abs(Decimal(balance_value))),
                (
                    "经营利润已补充 "
                    + cash(extra.get("preopening_profit_covered") or "0")
                    + " / 超支未补充 "
                    + cash(extra.get("preopening_uncovered") or "0")
                )
                if balance_value is not None
                else "",
            ),
            ("累计投入", cash(extra["total_capital"]), "筹建投入及累计运营增资"),
            ("累计分红", cash(extra["cumulative_distribution"]), "截至本月"),
        ],
    )
    add(
        "核心成本率",
        ["成本项目", "金额", "成本率"],
        [
            [name, cash(m.get(amount)), "—" if m.get(rate) is None else str(m[rate]) + "%"]
            for name, amount, rate in [
                ("食材成本", "food_cost_amount", "food_cost_rate"),
                ("人工成本", "labor_cost_amount", "labor_cost_rate"),
                ("租金成本", "rent_cost_amount", "rent_cost_rate"),
            ]
        ],
    )
    roots = {}

    def root(name):
        return roots.setdefault(name, {"amount": Decimal(0), "history": Decimal(0), "children": {}})

    for r in m["expense_category_summary"]:
        name, _, child = r["name"].partition(" / ")
        node = root(name)
        node["amount"] += Decimal(r["amount"])
        if child:
            node["children"].setdefault(child, {"amount": Decimal(0), "history": Decimal(0)})[
                "amount"
            ] += Decimal(r["amount"])
    for r in extra.get("historical_category_expenses", []):
        name, _, child = r["name"].partition(" / ")
        node = root(name)
        node["history"] += Decimal(r["amount"])
        if child:
            node["children"].setdefault(child, {"amount": Decimal(0), "history": Decimal(0)})[
                "history"
            ] += Decimal(r["amount"])
    for name, amount in [
        ("食材成本", Decimal(m["food_cost_amount"])),
        ("运营支出", Decimal(m["expense_amount"]) - Decimal(m["food_cost_amount"])),
    ]:
        rows = []
        for key, node in sorted(roots.items(), key=lambda pair: pair[1]["amount"], reverse=True):
            if (key == "食材成本") != (name == "食材成本"):
                continue
            for label, n in [(key, node)] + [
                ("  " + child, n)
                for child, n in sorted(
                    node["children"].items(), key=lambda pair: pair[1]["amount"], reverse=True
                )
            ]:
                rows.append(
                    [
                        label,
                        cash(n["amount"]),
                        percent(n["amount"], m["income_amount"]),
                        percent(n["amount"], m["expense_amount"]),
                        cash(n["history"]),
                    ]
                )
        add(
            "各类别支出统计 · " + name,
            ["费用分类", "金额", "占营业收入", "占总支出", "历史累计支出"],
            rows,
            "合计 "
            + cash(amount)
            + "；占营业收入 "
            + percent(amount, m["income_amount"])
            + "；占总支出 "
            + percent(amount, m["expense_amount"])
            + "；累计截至 "
            + report["period"],
        )
    add(
        "计提与冲销费用",
        ["分类", "日期", "内容", "入账金额"],
        [
            [
                " / ".join(filter(None, [r.get("category_l1"), r.get("category_l2")])),
                r["date"],
                r["description"],
                cash(r["amount"]),
            ]
            for r in extra.get("accrual_details", [])
        ],
        "已计入分类和总支出，冲销为负数，不重复累计。",
    )
    appendix = snapshot["appendix"]
    special_rows = []
    for r in appendix["rows"]:
        bank = r["transaction"]
        kind = bank.get("direct_posting_type") or bank.get("special_type")
        if not kind:
            continue
        special_rows.append(
            [
                bank["occurred_at"][:10],
                bank.get("ledger_period") or "—",
                bank["occurred_at"][:7]
                if bank.get("direct_posting_type")
                else "以审批对账记录为准",
                FLOW_LABELS.get(kind, kind),
                "收入" if bank["direction"] == "income" else "支出",
                cash(bank["amount"]),
                bank.get("counterparty_name") or "—",
                bank.get("summary") or "—",
                bank.get("bank_serial_no") or bank["id"],
            ]
        )
    add(
        "特殊流水",
        ["日期", "所属账期", "入账月份", "属性", "方向", "金额", "对方户名", "备注", "来源流水号"],
        special_rows,
        "按各自规则计费，本表不重复累计。来源流水号可用于在小程序或PC查询原流水。",
    )
    expenses = {
        r["id"]: r
        for r in appendix["expense_items"]
        if r.get("category_l1") != "手续费" and r.get("source") != "revenue_fee"
    }
    displayed = {}
    rows = []
    number = 0
    for group in appendix["rows"]:
        bank = group["transaction"]
        if bank["direction"] != "expense":
            continue
        ids = list(
            dict.fromkeys(
                d["expense_id"]
                for b in group["business"]
                if b["kind"] == "expense"
                for d in b.get("expense_details", [])
                if d.get("expense_id") in expenses
            )
        )
        if not ids:
            continue
        number += 1
        for index, key in enumerate(ids):
            item = expenses[key]
            rows.append(
                [
                    f"流水 {number}"
                    + ("（明细续行）" if index else "")
                    + "\n"
                    + (bank.get("counterparty_name") or "—")
                    + "\n流水总额\n"
                    + cash(bank["amount"]),
                    bank["occurred_at"][:10],
                    item.get("category_l2") or item.get("category_l1") or "未分类",
                    item["description"],
                    str(item.get("application_date") or item.get("expense_date") or "—")[:10],
                    "同流水 " + str(displayed[key]) + " 费用，不重复计入"
                    if key in displayed
                    else cash(item["amount"]),
                ]
            )
            displayed.setdefault(key, number)
    for key, item in expenses.items():
        if key not in displayed:
            rows.append(
                [
                    "未关联银行流水",
                    str(item.get("expense_date") or "—")[:10],
                    item.get("category_l2") or item.get("category_l1") or "未分类",
                    item["description"],
                    str(item.get("application_date") or item.get("expense_date") or "—")[:10],
                    cash(item["amount"]),
                ]
            )
    add(
        "支出明细",
        ["银行流水", "支出日期", "二级分类", "支出详情", "申请报销日期", "详情金额"],
        rows,
        "明细续行属于同一笔流水，不代表新增付款；详情金额为本期入账金额，流水总额不可作为费用再次相加。手续费不逐条列示。",
    )
    add(
        "主要支出凭证",
        ["费用名称", "账期", "展示金额", "附件数", "备注"],
        [
            [
                r["expense_name"],
                r["ledger_period"],
                cash(r["display_amount"]),
                str(r.get("attachment_count", 0)),
                r.get("remark") or "—",
            ]
            for r in snapshot.get("major_vouchers", [])
        ],
        "仅归档展示，不计入利润。",
    )
    business_rows = []
    for r in appendix["rows"]:
        bank = r["transaction"]
        notes = []
        for business in r["business"]:
            if business["kind"] == "income":
                notes.append(
                    (business.get("description") or "营业收入")
                    + " · "
                    + str(business.get("revenue_start") or "—")
                    + " 至 "
                    + str(business.get("revenue_end") or "—")
                    + " · 关联金额 "
                    + cash(business.get("accounting_amount"))
                )
            else:
                note = (
                    (business.get("approval_no") or "审批报销")
                    + " · 申请日期 "
                    + str(business.get("application_date") or "—")[:10]
                    + "\n"
                )
                note += "\n".join(
                    " / ".join(filter(None, [d.get("category_l1"), d.get("category_l2")]))
                    + " "
                    + d.get("description", "")
                    + (" " + cash(d["amount"]) if "amount" in d else "")
                    for d in business.get("expense_details", [business])
                )
                note += "\n确认入账金额 " + cash(business.get("accounting_amount"))
                if business.get("settlement_group") or business.get("shared_accounting_amount"):
                    note += "（多笔实付共享费用，不重复累计）"
                notes.append(note)
        business_rows.append(
            [
                bank["occurred_at"][:10],
                "收入" if bank["direction"] == "income" else "支出",
                bank.get("counterparty_name") or "—",
                cash(bank["amount"]),
                "\n".join(notes) or bank.get("summary") or "—",
            ]
        )
    add(
        "流水业务附录",
        ["日期", "方向", "对方户名", "流水金额", "关联业务 / 备注"],
        business_rows,
        "银行金额不等于费用；多笔支付共享的审批费用不可重复累计。",
    )
    return out


def html(snapshot, receipts, warnings):
    title = snapshot["report"]["store"]["name"] + " · " + snapshot["report"]["period"] + " 财务报表"
    pieces = [
        "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>"
        + escape(title)
        + "</title><style>body{max-width:960px;margin:32px auto;color:#203f38;font:14px/1.7 sans-serif;padding:16px}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{padding:8px;border:1px solid #dbe7df;overflow-wrap:anywhere;white-space:pre-wrap;vertical-align:top}th{background:#edf5f0}h2{margin-top:30px}img{max-width:90%;max-height:600px}tr{break-inside:avoid}thead{display:table-header-group}</style><body><h1>"
        + escape(title)
        + "</h1><p>快照时间："
        + escape(snapshot["retrieved_at"])
        + "；审批费用按入账月份，与银行发生日期无关。</p>"
    ]
    for section in sections(snapshot):
        pieces.append(
            "<h2>"
            + escape(section["title"])
            + "</h2><p>"
            + escape(section["note"])
            + "</p><table><thead><tr>"
            + "".join("<th>" + escape(str(v)) + "</th>" for v in section["headers"])
            + "</tr></thead><tbody>"
            + "".join(
                "<tr>" + "".join("<td>" + escape(str(v)) + "</td>" for v in row) + "</tr>"
                for row in section["rows"]
            )
            + "</tbody></table>"
        )
    pieces.append("<h2>图片凭证与附件</h2>")
    for r in receipts:
        pieces.append(
            "<h3>"
            + escape(r["name"])
            + "</h3>"
            + (
                "<img src='data:" + r["mime"] + ";base64," + r["data"] + "' alt='凭证'>"
                if r.get("data")
                else "<p>文件凭证，请在小程序凭证页查看。</p>"
            )
        )
    if warnings:
        pieces.append("<h2>导出提示</h2>" + "".join("<p>" + escape(w) + "</p>" for w in warnings))
    return "".join(pieces) + "</body></html>"


def pdf(snapshot, receipts, warnings):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import (
        Image,
        KeepTogether,
        LongTable,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        TableStyle,
    )

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    style = ParagraphStyle("body", fontName="STSong-Light", fontSize=9, leading=14, wordWrap="CJK")
    heading = ParagraphStyle(
        "heading",
        parent=style,
        fontSize=15,
        leading=22,
        spaceBefore=18,
        spaceAfter=10,
        keepWithNext=True,
    )

    def p(value):
        text = escape(str(value)).replace("\n", "<br/>")

        def amount(match):
            prefix = (
                "" if match.start() == 0 or text[: match.start()].endswith("<br/>") else "<br/>"
            )
            return prefix + "<nobr>" + match.group() + "</nobr>"

        text = re.sub(r"-?¥[\d,]+\.\d{2}", amount, text)
        return Paragraph(text, style)

    out = BytesIO()
    story = []
    doc = SimpleDocTemplate(
        out, pagesize=A4, rightMargin=32, leftMargin=32, topMargin=32, bottomMargin=36
    )
    title = snapshot["report"]["store"]["name"] + " · " + snapshot["report"]["period"] + " 财务报表"
    story += [
        Paragraph(escape(title), heading),
        p("快照时间：" + snapshot["retrieved_at"]),
        p("审批费用按入账月份，银行发生日期不决定费用归属。"),
    ]
    for section in sections(snapshot):
        story.append(Paragraph(escape(section["title"]), heading))
        if section["note"]:
            note = p(section["note"])
            note.keepWithNext = True
            spacer = Spacer(1, 6)
            spacer.keepWithNext = True
            story.extend([note, spacer])
        if not section["rows"]:
            story.append(p("暂无记录"))
            continue
        widths = (
            [0.20, 0.12, 0.10, 0.27, 0.14, 0.17]
            if section["title"] == "支出明细"
            else [1 / len(section["headers"])] * len(section["headers"])
        )
        cells = [[p(v) for v in row] for row in [section["headers"]] + section["rows"]]
        col_widths = [doc.width * v for v in widths]
        oversized = any(
            max(
                cell.wrap(width - 12, 100000)[1]
                for cell, width in zip(row, col_widths, strict=True)
            )
            + 14
            > doc.height - 70
            for row in cells[1:]
        )
        table = LongTable(cells, colWidths=col_widths, repeatRows=1, splitInRow=int(oversized))
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9f2ed")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d7e5de")),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            )
        )
        story.append(table)
    for index, r in enumerate(receipts):
        block = [Paragraph("图片凭证与附件", heading)] if index == 0 else []
        block.append(p(r["name"]))
        if r.get("data"):
            image = Image(BytesIO(base64.b64decode(r["data"])))
            image._restrictSize(doc.width, 560)
            block.extend([Spacer(1, 6), image, Spacer(1, 12)])
        else:
            block.append(p("非图片文件，请在小程序凭证页查看。"))
        story.append(KeepTogether(block))
    if warnings:
        story.append(Paragraph("导出提示", heading))
        story.extend(p(w) for w in warnings)

    def footer(canvas, document):
        canvas.setFont("STSong-Light", 9)
        canvas.drawString(32, 18, snapshot["report"]["period"] + " | 财务报表")
        canvas.drawRightString(A4[0] - 32, 18, str(document.page))

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return out.getvalue()
