from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import StyleReport
from app.services.history import build_style_report

router = APIRouter(prefix="/v1/analytics", tags=["analytics"])


@router.get("/style-report", response_model=StyleReport)
def style_report(limit: int = Query(200, ge=1, le=2000), db: Session = Depends(get_db)):
    return build_style_report(db, limit=limit)
