# Docker Monitoring (Grafana + Prometheus)

> Esta stack fornece a camada de **histórico de métricas** do sistema unificado
> **[Well Container Monitor](../README.md)**. O painel
> operacional (status em tempo real, ações, logs, terminal) fica na raiz do
> projeto `Monitoramento-geral`, que incorpora o dashboard do Grafana abaixo na
> aba "Métricas Históricas".

Stack pronta para monitorar os containers Docker da maquina `192.168.1.54` com:

- `docker-service-exporter`: metricas por servico Docker (status, CPU, memoria, reinicios)
- `cAdvisor`: metricas tecnicas de cgroups (apoio)
- `node-exporter`: metricas do host (CPU, memoria, disco, rede)
- `Prometheus`: coleta e armazenamento das metricas
- `Grafana`: visualizacao e dashboards

## Arquitetura

- `docker-service-exporter` coleta dados do Docker via socket local e grava metricas no `textfile collector` do `node-exporter`
- O exporter de servicos foi implementado em Python
- `node-exporter` expoe metricas do host + metricas customizadas por servico
- `cAdvisor` permanece para metricas de baixo nivel
- `Prometheus` coleta desses exporters
- `Grafana` le do `Prometheus`

Como os exporters rodam na mesma maquina Docker, **novos containers que voce subir no futuro ja entram no monitoramento automaticamente** no dashboard por servico.

## Estrutura

```text
.
├── docker-compose.yml
├── docker-service-exporter/
│   ├── Dockerfile
│   └── exporter.py
├── grafana/
│   ├── dashboards/
│   │   └── docker-overview.json
│   └── provisioning/
│       ├── dashboards/
│       │   └── dashboards.yml
│       └── datasources/
│           └── datasource.yml
└── prometheus/
    ├── alerts/
    │   └── docker-host-alerts.yml
    └── prometheus.yml
```

## Subir o ambiente

No diretorio `docker-monitoramento`:

```bash
docker compose up -d
```

## Acesso

- Grafana: `http://192.168.1.54:3000`
  - usuario: `admin`
  - senha: `admin123`
  - Acesso anonimo (`Viewer`) e embedding habilitados
    (`GF_AUTH_ANONYMOUS_ENABLED`, `GF_SECURITY_ALLOW_EMBEDDING`), para que o
    dashboard "Docker Services Overview" possa ser exibido via `<iframe>` no
    Well Container Monitor sem exigir login.
- Prometheus: `http://192.168.1.54:9090`

`cAdvisor` e `node-exporter` ficam acessiveis apenas na rede interna do Compose (mais seguro e sem conflito de porta).

## Dashboard organizado por servicos

Dashboard principal: `Docker Services Overview`

- Exibe somente servicos da aplicacao por padrao (ignora servicos internos de monitoramento)
- Filtro `Servico` no topo para selecionar um ou varios servicos
- Cards principais: servicos saudaveis, servicos com problema, CPU media e memoria media
- Graficos por servico: CPU e memoria
- Tabelas operacionais: status e memoria por servico, CPU atual, reinicios e PIDs

Com isso, o usuario consegue operar e investigar os servicos **diretamente no Grafana**, sem depender de consultas manuais no terminal.

## Status dos servicos (funcionando corretamente ou nao)

O stack publica a metrica `docker_service_ok`:

- `1` = servico em execucao e saudavel (ou sem healthcheck)
- `0` = servico parado/falho/unhealthy

Consultas uteis no Prometheus:

```bash
# Status de todos os servicos da aplicacao
curl -s 'http://192.168.1.54:9090/api/v1/query?query=docker_service_ok%7Bservice!~%22cadvisor%7Cnode-exporter%7Cprometheus%7Cgrafana%7Cdocker-service-exporter%22%7D'

# Apenas servicos com problema
curl -s 'http://192.168.1.54:9090/api/v1/query?query=docker_service_ok%7Bservice!~%22cadvisor%7Cnode-exporter%7Cprometheus%7Cgrafana%7Cdocker-service-exporter%22%7D%20%3D%3D%200'
```

## Alertas incluidos

Arquivo: `prometheus/alerts/docker-host-alerts.yml`

- Exporter fora do ar
- CPU do host acima de 85%
- Memoria do host acima de 90%
- Container com memoria acima de 90% do limite

## Operacao diaria

```bash
# Ver status dos servicos
docker compose ps

# Ver logs
docker compose logs -f prometheus
docker compose logs -f grafana

# Reiniciar stack
docker compose restart

# Parar stack
docker compose down
```

## Expandir no futuro

Voce nao precisa alterar nada para novos containers na mesma maquina: o `docker-service-exporter` coleta automaticamente os novos servicos em execucao.

Se no futuro quiser monitorar **outras maquinas** tambem, adicione novos targets em `prometheus/prometheus.yml` (ou use service discovery) e exponha exporters nessas maquinas.

## Seguranca recomendada (producao)

- Trocar senha padrao do Grafana
- Colocar Grafana/Prometheus atras de reverse proxy com TLS
- Restringir portas no firewall (3000, 9090)
