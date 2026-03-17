# Escala CHBV — Centro Hospitalar do Baixo Vouga

App de gestão de escalas médicas para o Hospital de Aveiro.

## Como usar

1. Clone o repositório:
   ```bash
   git clone https://github.com/SEU_UTILIZADOR/hospital-scheduler.git
   cd hospital-scheduler
   ```

2. Inicie um servidor local:
   ```bash
   python3 -m http.server 8080
   ```

3. Abra o browser em **http://localhost:8080**

## Funcionalidades

- Escala mensal com turnos Diurno (8:30–20:30) e Noturno (20:30–8:30)
- Gestão de médicos com horário fixo e disponibilidade mensal
- Regras mensais por dia da semana
- Rotações automáticas (semana A / semana B)
- Auto-preenchimento inteligente com respeito por limites de horas
- Exportar / Importar dados em JSON
- Resumo de horas fixas e extra por médico

## Dados

Os dados são guardados no `localStorage` do browser. Use o botão **Exportar** regularmente para fazer backup.
