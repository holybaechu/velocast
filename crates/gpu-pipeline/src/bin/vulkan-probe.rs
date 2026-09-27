use gpu_pipeline::{probe, ExerciseReport, FramePool};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let exercise = args.iter().any(|arg| arg == "--exercise-nv12");
    let device_index = args
        .windows(2)
        .find(|w| w[0] == "--device")
        .and_then(|w| w[1].parse::<usize>().ok())
        .unwrap_or(0);
    let mut report = match probe() {
        Ok(report) => report,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    if exercise {
        match FramePool::new(device_index, 128, 72, 2).and_then(|mut pool| {
            if pool.copy_ready_frame(0, 1).is_ok() {
                return Err(gpu_pipeline::PoolError(
                    "uninitialized GPU copy accepted".into(),
                ));
            }
            pool.exercise_copy()?;
            pool.copy_ready_frame(0, 1)?;
            let count = pool.len();
            if pool.frame(count).is_some() {
                return Err(gpu_pipeline::PoolError(
                    "out-of-bounds frame lease accepted".into(),
                ));
            }
            let lease = pool.frame(1).unwrap();
            let descriptor = lease.descriptor();
            Ok(ExerciseReport {
                device_index,
                width: descriptor.width,
                height: descriptor.height,
                frame_slots: count,
                diagnostic_readback_frames: 1,
                gpu_only_copies: 1,
                color: descriptor.color,
            })
        }) {
            Ok(exercise_report) => {
                if let Some(device) = report.devices.get_mut(device_index) {
                    device.nv12_image_usable = Some(true);
                }
                report.exercise = Some(exercise_report);
            }
            Err(error) => {
                eprintln!("NV12 pool exercise rejected: {error}");
                std::process::exit(2);
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
