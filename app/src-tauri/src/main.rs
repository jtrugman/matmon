// Matmon, Tauri shell entry point.
// All app logic lives in the React/TypeScript bundle; this file just wires the
// plugins listed in PRD §6 (sql, fs, http, dialog, notification).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    matmon_lib::run();
}
