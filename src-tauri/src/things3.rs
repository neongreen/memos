//! A module for interacting with Things 3.
//!
//! See https://culturedcode.com/things/support/articles/2803573/#json

use serde::{Serialize, Serializer};
use serde_json::json;

#[derive(Serialize)]
pub struct Todo {
    pub title: String,
    pub notes: Option<String>,
}

pub enum Item {
    Todo(Todo),
}

impl Serialize for Item {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let json = match self {
            Item::Todo(todo) => json!({
                "type": "to-do",
                "attributes": &todo,
            }),
        };
        json.serialize(serializer)
    }
}
