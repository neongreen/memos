# Memos

Screenshot:

![Screenshot of the app](memos-screenshot-jun12-2023.png)

## Using this app if you're not me

* You need to figure out what the env vars are. Or just ask me.
* Some features, like "Play" and "Add to Things", only work on macOS right now.

## Dev notes

### Run the app with hot reloading

```bash
yarn tauri dev
```

### Upgrade Rust dependencies & Rust compiler

```bash
cd src-tauri
# Change the versions in Cargo.toml
rustup update
cargo update
```

### Upgrade Deno

```bash
deno upgrade
```

(NB: don't use the Brew version.)

### Import memos into the database

```bash
deno run -A import-memos/index.ts
```

### Add a Rust dep

```bash
cd src-tauri
cargo add ...
```
