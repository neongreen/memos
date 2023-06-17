# Memos

Screenshot:

![Screenshot of the app](memos-screenshot-jun12-2023.png)

## How to

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