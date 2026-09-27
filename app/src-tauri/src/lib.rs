use tauri_plugin_sql::{Migration, MigrationKind};

const SCHEMA_V1: &str = include_str!("../migrations/V1__init.sql");
const SCHEMA_V2: &str = include_str!("../migrations/V2__prices_prev_close.sql");
const SCHEMA_V3: &str = include_str!("../migrations/V3__instruments.sql");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create core tables",
            sql: SCHEMA_V1,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add prev_close to prices for today's day-change math",
            sql: SCHEMA_V2,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add instruments table for per-symbol sector / industry metadata",
            sql: SCHEMA_V3,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:portfolio.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running Matmon");
}
