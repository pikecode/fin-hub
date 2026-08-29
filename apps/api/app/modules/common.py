from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session


def paginate(session: Session, query: Select, page: int, page_size: int) -> tuple[list, int]:
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    items = session.scalars(query.offset((page - 1) * page_size).limit(page_size)).all()
    return items, total
