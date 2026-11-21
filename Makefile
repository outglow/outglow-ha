PY ?= .venv/bin/python
ENGINE_PATHS = custom_components/outglow/engine tools tests/engine tests/contract.py tests/test_contracts.py tests/test_repo.py tests/test_docs.py tests/conftest.py

.PHONY: check test-engine test-ha lint types contracts docs docs-check frontend frontend-test e2e docs-images docs-images-check hooks pre-commit

check: contracts docs-check lint types test-engine test-ha frontend-test frontend

test-engine:
	$(PY) -m pytest tests/engine tests/test_contracts.py tests/test_repo.py tests/test_docs.py -q --cov=custom_components/outglow/engine --cov-report=term-missing --cov-fail-under=100

test-ha:
	$(PY) -m pytest tests/integration -q

lint:
	$(PY) -m ruff format --check .
	$(PY) -m ruff check .

types:
	MYPYPATH=custom_components/outglow $(PY) -m mypy $(ENGINE_PATHS)
	$(PY) -m mypy custom_components/outglow tests/integration

contracts:
	$(PY) tools/contracts.py --check

docs:
	$(PY) tools/contracts.py
	$(PY) tools/docs.py

docs-check:
	$(PY) tools/docs.py --check

frontend-test:
	npm --prefix frontend run typecheck
	npm --prefix frontend test

frontend:
	npm --prefix frontend run build

e2e:
	cd frontend && npx playwright test

docs-images:
	npm --prefix frontend run shots -- --docs --docker

docs-images-check:
	npm --prefix frontend run shots -- --check --docker

hooks:
	git config core.hooksPath .githooks
	@echo "pre-commit hook on: .githooks/pre-commit"

pre-commit:
	.githooks/pre-commit
