# Testes de ponta a ponta (escala por células)

Corre a app real num browser contra uma base de dados Postgres local configurada como
o Supabase (mesmas regras de segurança, utilizador `authenticated`, `auth.uid()`).
Nada aqui toca no Supabase real.

Requisitos: Postgres local (por omissão socket em `/var/tmp/pgt`, porta 5499),
Node, `npm i pg playwright` nesta pasta (ou `PG_MODULE` a apontar para o módulo `pg`).

```bash
./run-setup.sh                      # base de dados de teste com uma escala gerada
node server.js &                    # serve a app + um substituto do Supabase em :8787
node t1.js                          # cenários: edição, conflito, repetição, telemóvel antigo,
                                    # limpar mês + desfazer, voltar atrás, tarefeiro, Chipre,
                                    # restaurar cópia, auto-preencher, remover médico, rollback
```
