#![cfg(unix)]

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn load_uses_the_captured_props_before_discovery_preserving_null_and_omission() {
    let directory = std::env::temp_dir().join(format!(
        "velocast-input-snapshot-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    let root = Scratch(directory);
    let host = root.0.join("host.sh");
    fs::write(&host, r#"
printf '%s\n' '{"label":"mutated"}' > "$VELOCAST_TEST_SNAPSHOT_PROPS"
printf '{"event":"ready","version":4,"pid":%s}\n' "$$"
while IFS= read -r request; do
    printf '%s\n' "$request" >> "$VELOCAST_TEST_SNAPSHOT_LOG"
    id=${request#*\"id\":}; id=${id%%,*}; id=${id%%\}*}
    case "$request" in
        *getCompositions*) result='[{\"id\":\"hero\",\"width\":16,\"height\":16,\"fps\":30,\"durationFrames\":10}]' ;;
        *) result='' ;;
    esac
    printf '{"id":%s,"ok":true,"result":"%s"}\n' "$id" "$result"
    case "$request" in *'"method":"close"'*) exit 0 ;; esac
done
"#).unwrap();

    for (index, captured) in [
        Some(json!({"text":"quote \" slash \\ newline\n한글 </script>","count":1})),
        Some(Value::Null),
        None,
    ]
    .into_iter()
    .enumerate()
    {
        let props_path = root.0.join(format!("props-{index}.json"));
        let requests = root.0.join(format!("requests-{index}.jsonl"));
        let mut job = json!({
            "mode":"composition", "operation":"inspect", "composition_id":"hero",
            "serve_url":"http://127.0.0.1/", "output":root.0.join("unused.mp4"),
            "codec":"h264", "result_path":root.0.join(format!("result-{index}.json")),
        });
        if let Some(value) = &captured {
            fs::write(&props_path, serde_json::to_vec(value).unwrap()).unwrap();
            job["input_props_path"] = json!(props_path);
        }
        let output = Command::new(env!("CARGO_BIN_EXE_velocast-renderer"))
            .args(["--job-json", &job.to_string()])
            .env("VELOCAST_ELECTRON_BINARY", "/bin/sh")
            .env("VELOCAST_ELECTRON_HOST_SCRIPT", &host)
            .env("VELOCAST_TEST_SNAPSHOT_PROPS", &props_path)
            .env("VELOCAST_TEST_SNAPSHOT_LOG", &requests)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&props_path).unwrap()).unwrap(),
            json!({"label":"mutated"})
        );
        let scripts = fs::read_to_string(requests)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter_map(|request| request["script"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let props = scripts
            .iter()
            .enumerate()
            .filter(|(_, script)| script.contains("window.__velocastRenderer.setInputProps("))
            .collect::<Vec<_>>();
        if let Some(value) = captured {
            assert_eq!(props.len(), 1);
            assert!(
                props[0].1.contains(&format!(
                    "window.__velocastRenderer.setInputProps({})",
                    serde_json::to_string(&value).unwrap()
                )),
                "{}",
                props[0].1
            );
            let discovery = scripts
                .iter()
                .position(|script| script.contains("window.__velocast.getCompositions()"))
                .unwrap();
            assert!(props[0].0 < discovery);
        } else {
            assert!(props.is_empty());
        }
    }
}
