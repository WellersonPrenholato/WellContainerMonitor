BACKEND_DIR := backend
FRONTEND_DIR := frontend
VENV := $(BACKEND_DIR)/.venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
FRONTEND_PORT := 8088

BACKEND_PID := /tmp/docker-monitor-backend.pid
FRONTEND_PID := /tmp/docker-monitor-frontend.pid

.PHONY: help install backend frontend run stop logs clean

help:
	@echo "Alvos disponiveis:"
	@echo "  make install   - cria o venv e instala as dependencias do backend"
	@echo "  make backend   - executa o backend em foreground (porta 5050)"
	@echo "  make frontend  - executa o frontend em foreground (porta $(FRONTEND_PORT))"
	@echo "  make run       - inicia backend e frontend em background"
	@echo "  make stop      - para backend e frontend iniciados com 'make run'"
	@echo "  make logs      - acompanha o log do backend"
	@echo "  make clean     - remove o venv e arquivos temporarios"

install:
	python3 -m venv $(VENV)
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt

backend:
	cd $(BACKEND_DIR) && ../$(PYTHON) app.py

frontend:
	cd $(FRONTEND_DIR) && python3 -m http.server $(FRONTEND_PORT)

run:
	cd $(BACKEND_DIR) && nohup ../$(PYTHON) app.py > app.log 2>&1 & echo $$! > $(BACKEND_PID)
	cd $(FRONTEND_DIR) && nohup python3 -m http.server $(FRONTEND_PORT) > frontend.log 2>&1 & echo $$! > $(FRONTEND_PID)
	@sleep 1
	@echo "Backend rodando em http://0.0.0.0:5050 (pid $$(cat $(BACKEND_PID)))"
	@echo "Frontend rodando em http://0.0.0.0:$(FRONTEND_PORT) (pid $$(cat $(FRONTEND_PID)))"

stop:
	-kill $$(cat $(BACKEND_PID)) 2>/dev/null && rm -f $(BACKEND_PID)
	-kill $$(cat $(FRONTEND_PID)) 2>/dev/null && rm -f $(FRONTEND_PID)
	@echo "Servicos parados."

logs:
	tail -f $(BACKEND_DIR)/app.log

clean: stop
	rm -rf $(VENV)
	rm -f $(BACKEND_DIR)/app.log $(FRONTEND_DIR)/frontend.log
