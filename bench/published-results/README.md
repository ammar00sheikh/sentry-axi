# Published results

Empty on purpose.

Results land here only from a real, full `matrix` run:

```sh
npm run bench -- matrix --repeat 5
```

which writes `results/{sentry-axi,sentry-mcp}.jsonl`, `results/report.md` and
`results/report.csv`. Those artifacts get copied into this directory — together
with the seeded fixture's ground truth and the agent/judge model ids — once the
run has actually happened.

Nothing is committed here before then. Numbers in a benchmark README are only
worth the run that produced them; a plausible-looking table that no run produced
is a fabrication, not a placeholder.
