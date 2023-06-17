#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use rusqlite::{types::Value, Connection};
use serde::Serialize;
use std::env;
use std::path::Path;
use std::process::Command;
use std::{
    rc::Rc,
    sync::{Arc, Mutex},
};
use tauri::InvokeError;
// use tauri::{CustomMenuItem, Menu, MenuItem, Submenu};

#[derive(Debug, Serialize)]
struct Row {
    name: String,
    content: String,
    label: Option<String>,
}

struct State {
    db_conn: Arc<Mutex<Connection>>,
}

fn main() {
    // Load the .env file
    dotenvy::dotenv().expect("Failed to read .env file");

    let connection =
        Connection::open(env::var("MEMOS_DB").expect("MEMOS_DB env var missing"))
            .expect("Couldn't open database");
    rusqlite::vtab::array::load_module(&connection).expect("Couldn't load array module");

    // let menu = Menu::new();

    tauri::Builder::default()
        // .menu(menu)
        .manage(State {
            db_conn: Arc::new(Mutex::from(connection)),
        })
        .invoke_handler(tauri::generate_handler![
            load,
            kill,
            merge,
            set_content,
            open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn tauri_error<E>(error: E) -> InvokeError
where
    E: std::fmt::Display,
{
    tauri::InvokeError::from(format!("{}", error))
}

/// Loads data from the database
#[tauri::command]
fn load(state: tauri::State<State>) -> Result<Vec<Row>, InvokeError> {
    let db_conn = state.db_conn.clone();
    let guard = db_conn.lock().map_err(tauri_error)?;
    let conn = &*guard;
    let mut select_stmt = conn
        .prepare("SELECT name, content, label FROM memos ORDER BY name ASC")
        .map_err(tauri_error)?;
    let mut rows_vec = Vec::new();
    select_stmt
        .query_and_then((), |row| {
            rows_vec.push(Row {
                name: row.get(0)?,
                content: row.get(1)?,
                label: row.get(2)?,
            });
            Ok::<(), rusqlite::Error>(())
        })
        .map_err(tauri_error)?
        .for_each(drop);
    Ok(rows_vec)
}

/// Deletes rows with given names
#[tauri::command]
fn kill(names: Vec<&str>, state: tauri::State<State>) -> Result<(), InvokeError> {
    let db_conn = state.db_conn.clone();
    let guard = db_conn.lock().map_err(tauri_error)?;
    let conn = &*guard;
    let names_param = Rc::new(
        names
            .iter()
            .copied()
            .map(|s| Value::from(String::from(s)))
            .collect::<Vec<Value>>(),
    );
    conn.execute("DELETE FROM memos WHERE name IN rarray(?1)", [names_param])
        .map_err(tauri_error)?;
    Ok(())
}

/// Merges rows with given names into one row
#[tauri::command]
fn merge(names: Vec<&str>, state: tauri::State<State>) -> Result<(), InvokeError> {
    let db_conn = state.db_conn.clone();
    let guard = db_conn.lock().map_err(tauri_error)?;
    let conn = &*guard;
    let names_param = Rc::new(
        names
            .iter()
            .copied()
            .map(|s| Value::from(String::from(s)))
            .collect::<Vec<Value>>(),
    );

    if names.len() < 2 {
        return Ok(());
    }

    let mut rows_vec = Vec::new();
    let mut select_stmt = conn
        .prepare(
            "SELECT name, content, label FROM memos WHERE name IN rarray(?1) ORDER BY name ASC",
        )
        .map_err(tauri_error)?;
    select_stmt
        .query_and_then([&names_param], |row| {
            rows_vec.push(Row {
                name: row.get(0)?,
                content: row.get(1)?,
                label: row.get(2)?,
            });
            Ok::<(), rusqlite::Error>(())
        })
        .map_err(tauri_error)?
        .for_each(drop);

    conn.execute("DELETE FROM memos WHERE name IN rarray(?1)", [&names_param])
        .map_err(tauri_error)?;

    let new_name = &rows_vec
        .iter()
        .map(|row| row.name.clone())
        .collect::<Vec<_>>()
        .join(",");
    let new_content = &rows_vec
        .iter()
        .map(|row| row.content.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    let new_label = &rows_vec
        .iter()
        .map(|row| row.label.clone())
        .filter_map(|option| option)
        .filter(|label| label != "unknown")
        .next() // works like ".first"
        .unwrap_or(String::from("unknown"));
    conn.execute(
        "INSERT INTO memos (name, content, label) VALUES (?1, ?2, ?3)",
        (new_name, new_content, new_label),
    )
    .map_err(tauri_error)?;

    Ok(())
}

/// Updates row content
#[tauri::command]
fn set_content(
    name: &str,
    new_content: &str,
    state: tauri::State<State>,
) -> Result<(), InvokeError> {
    let db_conn = state.db_conn.clone();
    let guard = db_conn.lock().map_err(tauri_error)?;
    let conn = &*guard;
    conn.execute(
        "UPDATE memos SET content = ?1 WHERE name = ?2",
        [new_content, name],
    )
    .map_err(tauri_error)?;
    Ok(())
}

/// Opens an audio file in the stored files directory.
///
/// If there are several files (separated with `,`), it will do `open` on all of them. For example, if you have macOS and VLC, it results in a playlist.
///
/// Currently only supports macOS because the `open` crate doesn't support passing several filenames. See https://github.com/Byron/open-rs/issues/70.
#[tauri::command]
fn open(name: &str) -> Result<(), InvokeError> {
    // Detect if any of the files don't exist, and throw an error if so.
    let files = name.split(',').collect::<Vec<_>>();
    let dir = env::var("VOICE_MEMOS_STORAGE").expect("VOICE_MEMOS_STORAGE not set");
    for file in &files {
        let path = Path::new(&dir).join(file);
        if !path.exists() {
            return Err(tauri_error(format!(
                "File {} doesn't exist",
                path.display()
            )));
        }
    }
    Command::new("/usr/bin/open")
        .current_dir(dir)
        .args(files)
        .spawn()
        .map_err(tauri_error)?;
    Ok(())
}
