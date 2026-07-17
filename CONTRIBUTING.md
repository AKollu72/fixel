# Contributing

## Local setup

Clone the repo and install dependencies:

```sh
git clone https://github.com/AKollu72/fixel.git
cd fixel
npm install
```

Create `.env.local` in the repo root with your credentials:

```sh
FIGMA_ACCESS_TOKEN=your_figma_pat
ANTHROPIC_API_KEY=your_anthropic_key   # or OPENAI_API_KEY
```

These are never committed — `.env.local` is in `.gitignore`.

Build:

```sh
npm run build   # compiles TypeScript to dist/
```

## Running tests

```sh
npm test
```

## Submitting changes

Open a pull request against `main`. Keep changes focused — one fix or feature
per PR.

By submitting a contribution you agree that your code will be licensed under
the same FSL-1.1-MIT terms as this project.
