"""Celery application.

Celery is only an executor. The authoritative job record is the ``GenerationJob``
row in Postgres (TD §3.1, T-008) — the result backend is deliberately left unset
so it cannot accidentally become the source of truth.
"""

import os

from celery import Celery

BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")

celery_app = Celery("aistudyassist", broker=BROKER_URL)
celery_app.conf.task_default_queue = "default"
