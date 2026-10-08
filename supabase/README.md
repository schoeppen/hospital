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
4. Correr `schedule-log-update.sql` (só funções; não toca em dados). Correr de novo
   sempre que as funções forem corrigidas.
5. Publicar a nova versão da app (merge para `main`). Funciona nos dois modos.
   Todos fecham e voltam a abrir a app (para já ninguém ficar com a versão antiga).
6. Correr `schedule-log-cutover.sql`. Conferir: *modo* = `cells`, *diferenças* = 0.
   Recusa-se (sem alterar nada) se houver outras regras de escrita em `app_data`.
   As abas abertas com a versão nova mudam de modo sozinhas.

## Voltar atrás

Correr `schedule-log-rollback.sql`. A app aberta muda sozinha para o modo antigo
(recarrega) e continua a funcionar. Nada se perde. Para voltar ao modo novo mais
tarde, correr de novo `schedule-log-cutover.sql` (traz as alterações feitas entretanto,
registadas).

## Testes

`tests/e2e/`: `t1.js` (22 cenários), `t2-rollout.js` (ensaio da passagem, com a app antiga e a nova abertas ao mesmo tempo, a partir do estado real de produção) e `t3-review.js` (casos da revisão independente).
