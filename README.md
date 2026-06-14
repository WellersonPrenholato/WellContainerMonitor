# Well Container Monitor

Sistema único de monitoramento de containers Docker, com duas camadas que se
complementam:

1. **Well Container Monitor** (este projeto) — painel operacional em tempo
   real, inspirado no Portainer: status, saúde, portas/URLs de acesso,
   métricas instantâneas, logs e ações administrativas (start/stop/restart/
   pause/terminal).
2. **Grafana + Prometheus** (subprojeto [`docker-monitoramento/`](docker-monitoramento/README.md))
   — histórico de métricas (CPU, memória, reinícios, status) coletado
   continuamente, acessível diretamente pela aba **Métricas Históricas** do
   Well Container Monitor.

Ou seja: o Well Container Monitor é o **painel único de entrada** — para o
estado *atual* dos containers e ações administrativas, ele mesmo serve os
dados; para *histórico/tendências*, ele incorpora os dashboards do Grafana.

## Estrutura do projeto

```
Monitoramento-geral/
├── backend/
│   ├── app.py              # API REST + WebSocket (Flask + Flask-SocketIO)
│   ├── docker_client.py     # Camada de acesso ao Docker (docker-py)
│   ├── requirements.txt     # Dependências Python
│   └── .venv/                # Ambiente virtual (criado localmente)
├── frontend/
│   ├── index.html            # SPA com 5 páginas (Dashboard, Containers, Logs, Métricas Históricas, Configurações)
│   ├── css/style.css          # Tema dark, responsivo
│   └── js/app.js              # Lógica do dashboard (fetch API + WebSocket + xterm.js)
└── docker-monitoramento/      # Stack de métricas históricas (Grafana + Prometheus)
    ├── docker-compose.yml      # Prometheus + Grafana + cAdvisor + exporters
    ├── docker-service-exporter/ # Exporter Python (status/CPU/memória/reinícios por container)
    ├── grafana/                 # Provisionamento + dashboard "Docker Services Overview"
    └── prometheus/              # Configuração de scrape + alertas
```

## Requisitos

- Linux com Docker instalado e o serviço `dockerd` em execução.
- Usuário com acesso ao socket `/var/run/docker.sock` (normalmente pertencer
  ao grupo `docker`: `sudo usermod -aG docker $USER`, depois reabrir a sessão).
- Python 3.10+ (testado com 3.14).
- Navegador moderno (Chrome, Firefox, Edge) para o frontend.

## 1. Backend (API + WebSocket)

### Instalação

```bash
cd Monitoramento-geral/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Configuração (variáveis de ambiente, opcionais)

| Variável                            | Padrão        | Descrição                                                                 |
|--------------------------------------|---------------|----------------------------------------------------------------------------|
| `DASHBOARD_HOST_ADDRESS`             | `192.168.1.54`| IP/host usado para montar as URLs clicáveis de acesso aos containers       |
| `DASHBOARD_UPDATE_INTERVAL_SECONDS`  | `5`           | Intervalo (segundos) entre transmissões via WebSocket                       |
| `DASHBOARD_PORT`                     | `5050`        | Porta em que a API/WebSocket fica disponível                                |

### Executar

```bash
cd Monitoramento-geral/backend
.venv/bin/python app.py
```

O servidor sobe em `http://0.0.0.0:5050`, expondo a API REST e o WebSocket.

Para rodar em segundo plano:

```bash
nohup .venv/bin/python app.py > app.log 2>&1 &
```

### Endpoints da API

| Método | Rota                                            | Descrição                                  |
|--------|--------------------------------------------------|----------------------------------------------|
| GET    | `/api/summary`                                   | Resumo (totais, ativos, saudáveis, CPU, memória) |
| GET    | `/api/containers`                                | Lista todos os containers com detalhes e stats |
| GET    | `/api/containers/<id>`                           | Detalhes de um container específico          |
| GET    | `/api/containers/<id>/logs?tail=200`             | Últimas N linhas de log (máx. 2000)           |
| POST   | `/api/containers/<id>/actions/<action>`          | Executa ação: `start`, `stop`, `restart`, `pause`, `unpause` |

### WebSocket

- Evento `containers_update`: emitido a cada `DASHBOARD_UPDATE_INTERVAL_SECONDS`,
  com `{ "summary": {...}, "containers": [...] }`.
- Eventos do terminal interativo: `terminal_start`, `terminal_input`,
  `terminal_resize`, `terminal_output`, `terminal_ready`, `terminal_error`,
  `terminal_stop`, `terminal_closed` (usados pela página de Containers ao
  abrir um terminal dentro do container).

## 2. Frontend (SPA)

O frontend é estático (HTML/CSS/JS puro), basta servi-lo com qualquer servidor HTTP.

### Executar (modo simples)

```bash
cd Monitoramento-geral/frontend
python3 -m http.server 8088
```

Acesse em `http://<IP-DO-SERVIDOR>:8088`.

### Configuração da API

Por padrão, o frontend assume que a API está no mesmo host, na porta `5050`
(`http://<host-atual>:5050`). Se a API estiver em outro endereço:

1. Acesse a página **Configurações** no menu lateral.
2. Informe o endereço completo da API (ex.: `http://192.168.1.54:5050`).
3. Clique em **Salvar** — a página recarrega usando a nova configuração
   (salva em `localStorage` do navegador).

## 3. Funcionalidades

### Dashboard
Cards de resumo (containers totais, ativos, parados, saudáveis, com problemas,
CPU total, memória total) e tabela rápida com status, imagem, uso de CPU/memória,
saúde e uptime de cada container.

### Containers
- Tabela completa com status, saúde, portas publicadas (com link clicável para
  acessar o serviço), uptime e ações rápidas.
- Filtros por nome, imagem, status e saúde.
- Painel de detalhes (ao clicar em uma linha): ID, imagem, datas de criação/
  início, health check (status, falhas consecutivas, última verificação, última
  saída), métricas (CPU, memória, rede RX/TX, disco leitura/escrita, PIDs),
  portas e ações administrativas.

### Ações administrativas
- **Iniciar**, **Parar**, **Reiniciar**, **Pausar/Retomar** — disponíveis na
  tabela e no painel de detalhes.
- Ações destrutivas (**Parar**, **Reiniciar**, **Pausar**) pedem confirmação
  antes de serem executadas.
- **Ver Logs** — abre a página de Logs já com o container selecionado.
- **Abrir Terminal** — abre um terminal interativo (via `docker exec`,
  `bash`/`sh`) direto no container, usando WebSocket + xterm.js.

### Logs
Seleção de container, quantidade de linhas (100/200/500/1000) e atualização manual.

### Métricas Históricas
Incorpora o dashboard **"Docker Services Overview"** do Grafana (via iframe),
com histórico de CPU, memória, reinícios e status dos serviços, além de botões
para abrir o Grafana e o Prometheus diretamente em outra aba. Veja a seção
[Camada de métricas históricas](#camada-de-métricas-históricas-grafana--prometheus)
para detalhes de como essa stack é executada.

### Configurações
Endereço da API, intervalo de atualização, endereço do Grafana e do Prometheus
— todos salvos localmente no navegador (`localStorage`).

### Tempo real
A cada `DASHBOARD_UPDATE_INTERVAL_SECONDS` (padrão 5s), o backend transmite via
WebSocket o resumo e a lista de containers atualizados; o indicador na barra
lateral mostra "Conectado"/"Desconectado".

## 4. Camada de métricas históricas (Grafana + Prometheus)

A subpasta `docker-monitoramento/` contém uma stack independente, via
`docker compose`, com Prometheus, Grafana, cAdvisor, node-exporter e o
`docker-service-exporter` (coleta status/CPU/memória/reinícios de cada
container). Essa stack:

- Já roda continuamente no servidor (`docker compose up -d` dentro de
  `docker-monitoramento/`) e **não precisa ser reiniciada** para usar o
  Well Container Monitor.
- Expõe Grafana em `http://<IP-DO-SERVIDOR>:3000` (usuário `admin`, senha
  `admin123`) e Prometheus em `http://<IP-DO-SERVIDOR>:9090`.
- Está configurada com `GF_SECURITY_ALLOW_EMBEDDING=true` e acesso anônimo
  (`Viewer`), permitindo que o dashboard "Docker Services Overview" seja
  exibido dentro da aba **Métricas Históricas** do Well Container Monitor via
  `<iframe>`, sem precisar de login.

Se o Grafana/Prometheus estiverem em outro host/porta, ajuste em
**Configurações** → "Endereço do Grafana" / "Endereço do Prometheus".

Detalhes completos dessa stack (arquitetura, alertas, dashboards) estão em
[`docker-monitoramento/README.md`](docker-monitoramento/README.md).

## 5. Acesso rápido (resumo dos comandos)

```bash
# Stack de métricas históricas (Grafana/Prometheus) — geralmente já está rodando
cd docker-monitoramento
docker compose up -d

# Terminal 1 — backend do Well Container Monitor
cd Monitoramento-geral/backend
.venv/bin/python app.py

# Terminal 2 — frontend do Well Container Monitor
cd Monitoramento-geral/frontend
python3 -m http.server 8088
```

Depois, abra `http://<IP-DO-SERVIDOR>:8088` no navegador — esse é o **painel
único** de monitoramento, com acesso direto a status, ações e histórico.

## 6. Usando o Makefile

Na raiz de `Monitoramento-geral/` há um `Makefile` com atalhos para todo o fluxo:

```bash
make install   # cria o venv e instala as dependencias do backend
make run       # inicia backend (porta 5050) e frontend (porta 8088) em background
make logs      # acompanha o log do backend em tempo real
make stop      # para backend e frontend iniciados com 'make run'
make clean     # para os servicos e remove o venv e logs

# Alternativas para rodar em foreground (um terminal por servico):
make backend
make frontend
```
