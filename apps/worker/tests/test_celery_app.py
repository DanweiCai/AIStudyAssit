from worker.celery_app import celery_app


def test_celery_app_is_configured() -> None:
    assert celery_app.main == "aistudyassist"


def test_result_backend_is_unset() -> None:
    # TD §3.1 / T-008: Postgres owns job state, never Celery's result backend.
    assert not celery_app.conf.result_backend
