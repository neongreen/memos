#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod things3;

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
use url::Url;
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
            add_to_things,
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

/// Play audio files in the stored files directory, using VLC, and exit afterwards.
///
/// If there are several files, it will play all of them one after the other.
#[tauri::command]
fn open(names: Vec<&str>) -> Result<(), InvokeError> {
    if !cfg!(target_os = "macos") {
        return Err(tauri_error("This command is only available on macOS"));
    }

    let dir = env::var("VOICE_MEMOS_STORAGE").expect("VOICE_MEMOS_STORAGE not set");

    // Detect if any of the files don't exist, and throw an error if so.
    for file in &names {
        let path = Path::new(&dir).join(file);
        if !path.exists() {
            return Err(tauri_error(format!(
                "File {} doesn't exist",
                path.display()
            )));
        }
    }

    Command::new("/Applications/VLC.app/Contents/MacOS/VLC")
        .current_dir(dir)
        .args([vec!["--play-and-exit"], names].concat())
        .spawn()
        .map_err(tauri_error)?;
    Ok(())
}

/// Add to Things (Inbox).
#[tauri::command]
fn add_to_things(
    names: Vec<&str>,
    state: tauri::State<State>,
) -> Result<(), InvokeError> {
    // Detect if Things is available.
    if !Path::new("/Applications/Things3.app").exists() {
        return Err(tauri_error("Things is not installed"));
    }

    // Get memo contents from the database.
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

    // Construct an array of things3::Item objects from the memos. Note the definition of Item: it's an enum with ItemTodo(Todo), and the Todo inside is a struct. Also, don't use mutability when creating a struct.
    let mut items: Vec<things3::Item> = Vec::new();
    for row in &rows_vec {
        items.push(things3::Item::Todo(things3::Todo {
            title: row.content.clone(),
            notes: None,
        }));
    }

    // Add to Things, using things:///json. For now we won't remove the memos from the database - it seems too risky.
    // TODO: I can use x-success to check that the things were added, and then it would be fine to remove them from the DB.
    let mut url = Url::parse("things:///json").unwrap();
    url.set_query(Some(&format!(
        "data={}",
        serde_json::to_string(&items).unwrap()
    )));
    url.query_pairs_mut()
        .append_pair("reveal", &true.to_string());
    Command::new("open")
        .arg(url.as_str())
        .spawn()
        .map_err(tauri_error)?;

    Ok(())
}
