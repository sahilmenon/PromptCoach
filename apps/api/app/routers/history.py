from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import HistoryImportRequest, HistoryImportResponse
from app.services.history import import_history, list_conversations

router = APIRouter(prefix="/v1/history", tags=["history"])


@router.post("/import", response_model=HistoryImportResponse)
def history_import(body: HistoryImportRequest, db: Session = Depends(get_db)):
    ids, n = import_history(db, body.source, body.payload)
    return HistoryImportResponse(conversation_ids=ids, turns_ingested=n)


@router.get("/conversations")
def conversations(db: Session = Depends(get_db)):
    return {"conversations": list_conversations(db)}
