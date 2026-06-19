use serde_json::{json, Value};

pub fn anthropic_tool_definitions() -> Value {
    json!([
        tool_definition(
            "list_directory",
            "List files under the plugin workspace.",
            path_props(),
            vec!["path"]
        ),
        tool_definition(
            "read_file",
            "Read a UTF-8 file from the plugin workspace.",
            path_props(),
            vec!["path"]
        ),
        tool_definition(
            "write_file",
            "Write a UTF-8 file inside the plugin workspace.",
            write_props(),
            vec!["path", "content"]
        ),
        tool_definition(
            "scan_workspace",
            "Return all small UTF-8 files in the plugin workspace.",
            json!({}),
            vec![]
        ),
        tool_definition(
            "list_local_directory",
            "List an absolute local directory without modifying it.",
            path_props(),
            vec!["path"]
        ),
        tool_definition(
            "read_local_file",
            "Read a UTF-8 file from an absolute local path.",
            local_read_props(),
            vec!["path"]
        ),
        tool_definition(
            "search_local_files",
            "Search UTF-8 files under an absolute local directory.",
            search_props(),
            vec!["path", "query"]
        ),
        tool_definition(
            "import_local_project",
            "Copy a local source file or directory into the plugin workspace.",
            import_props(),
            vec!["source_path"]
        ),
        tool_definition(
            "run_command",
            "Run a command in the plugin workspace and return real output.",
            command_props(),
            vec!["command"]
        )
    ])
}

pub fn openai_tool_definitions() -> Value {
    let tools = anthropic_tool_definitions();
    let Some(items) = tools.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["input_schema"],
                    }
                })
            })
            .collect(),
    )
}

fn object_schema(properties: Value, required: Vec<&str>) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

fn tool_definition(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({
        "name": name,
        "description": description,
        "input_schema": object_schema(properties, required),
    })
}

fn path_props() -> Value {
    json!({ "path": { "type": "string" } })
}

fn write_props() -> Value {
    json!({
        "path": { "type": "string" },
        "content": { "type": "string" }
    })
}

fn local_read_props() -> Value {
    json!({
        "path": { "type": "string" },
        "max_bytes": { "type": "integer" }
    })
}

fn search_props() -> Value {
    json!({
        "path": { "type": "string" },
        "query": { "type": "string" }
    })
}

fn import_props() -> Value {
    json!({
        "source_path": { "type": "string" },
        "destination": { "type": "string" }
    })
}

fn command_props() -> Value {
    json!({
        "command": { "type": "string" },
        "args": { "type": "array", "items": { "type": "string" } },
        "cwd": { "type": "string" }
    })
}
