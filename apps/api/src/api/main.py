"""FastAPI application entrypoint."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="AI Study Assistant API", version="0.1.0")


class Health(BaseModel):
    status: Literal["ok"]
    service: Literal["api"]


@app.get("/health")
def health() -> Health:
    return Health(status="ok", service="api")
