import pytest
from test_partial_approvals import match_bank, salary_fixture

from app.models import BankTransaction, ExpenseBankMatch


@pytest.mark.parametrize("batch", [False, True])
def test_delete_bank_after_unmatch_retains_history(client, session, batch):
    store, _approval, items, banks = salary_fixture(client, session)
    match_id = match_bank(client, items[0], banks[0])
    if batch:
        blocked = client.request(
            "DELETE", "/api/bank-transactions/batch", json={"ids": [banks[0].id]}
        )
    else:
        blocked = client.delete(f"/api/bank-transactions/{banks[0].id}")
    assert blocked.status_code == 409
    response = client.post(f"/api/matches/reconciliation/records/{match_id}/unmatch")
    assert response.status_code == 200, response.text
    bank_id = banks[0].id
    if batch:
        response = client.request("DELETE", "/api/bank-transactions/batch", json={"ids": [bank_id]})
    else:
        response = client.delete(f"/api/bank-transactions/{bank_id}")
    assert response.status_code == 200, response.text
    session.expire_all()
    assert session.get(BankTransaction, bank_id).is_archived
    assert session.get(ExpenseBankMatch, match_id).status == "rejected"
    listed = client.get("/api/bank-transactions", params={"store_id": store}).json()["data"]
    assert bank_id not in {row["id"] for row in listed["items"]}
