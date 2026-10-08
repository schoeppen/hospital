# Escala por células + registo de alterações — como pôr em produção

Cada turno é uma linha (`schedule_cells`) e cada alteração fica registada
(`schedule_log`: quem, quando, antes → depois). Qualquer alteração pode ser desfeita.
Cada edição leva um id (repetir não faz nada) e o valor que espera substituir
(uma edição feita numa cópia antiga é recusada em vez de apagar trabalho de outros).

A escala antiga (`app_data.chbv_schedules`) **nunca é apagada**: a base de dados
mantém-na sempre igual às células. Voltar atrás é sempre possível sem perder nada.

## Passos (por esta ordem)

1. **Exportar** na app (admin) e guardar o ficheiro JSON.
2. Supabase → SQL Editor: correr `../supabase-backups.sql` (cópias automáticas).
3. Correr `schedule-log-install.sql`. Conferir o relatório no fim:
   *diferenças (tem de ser 0)* = 0 e *modo da escala* = `blob`.
   Só acrescenta tabelas; a app continua a funcionar como antes.
4. Publicar a nova versão da app (merge para `main`). Funciona nos dois modos.
5. Correr `schedule-log-cutover.sql`. Conferir: *modo* = `cells`, *diferenças* = 0.
6. Todos fecham e voltam a abrir a app.

## Voltar atrás

Correr `schedule-log-rollback.sql`. A app aberta muda sozinha para o modo antigo
(recarrega) e continua a funcionar. Nada se perde. Para voltar ao modo novo mais
tarde, correr de novo `schedule-log-cutover.sql` (traz as alterações feitas entretanto,
registadas).

## Testes

`tests/e2e/` — 18 cenários contra uma base de dados local igual ao Supabase.
