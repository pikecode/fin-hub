FOOD_COST_CATEGORY_L1 = "食材成本"
PREPAID_FOOD_COST_CATEGORY_L2 = "快驴充值"
STORE_PREPAID_CATEGORY_L1 = "门店预充值"
RESERVE_FUND_LOAN_CATEGORY_L1 = "备用金/借款"
NON_OPERATING_EXPENSE_CATEGORY_L1 = {STORE_PREPAID_CATEGORY_L1, RESERVE_FUND_LOAN_CATEGORY_L1}


def is_non_operating_expense(category_l1: str | None, category_l2: str | None = None) -> bool:
    """Return categories that record cash/business facts but do not affect operating expense/profit."""
    return category_l1 in NON_OPERATING_EXPENSE_CATEGORY_L1 or (
        category_l1 == FOOD_COST_CATEGORY_L1 and category_l2 == PREPAID_FOOD_COST_CATEGORY_L2
    )
