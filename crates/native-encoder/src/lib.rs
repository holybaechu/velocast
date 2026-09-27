//! Node-API boundary. COM, D3D11 and FFmpeg live exclusively on one owned thread.
mod settings;
#[cfg(windows)]
mod windows;

use napi_derive::napi;
use settings::{Config, Frame};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use tokio::sync::{oneshot, watch};

type Reply = oneshot::Sender<Result<String, String>>;
enum Command {
    Ready(Reply),
    Frame(Frame, Reply),
    Finish(Reply),
}
impl Command {
    fn reject(self, error: &str) {
        let reply = match self {
            Self::Ready(r) | Self::Frame(_, r) | Self::Finish(r) => r,
        };
        let _ = reply.send(Err(error.into()));
    }
}
struct Ingress {
    sender: mpsc::SyncSender<Command>,
    finishing: bool,
}

#[napi]
pub struct NativeEncoder {
    ingress: Mutex<Ingress>,
    cancelled: Arc<AtomicBool>,
    stopped: watch::Receiver<bool>,
}

fn js_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi]
impl NativeEncoder {
    #[napi(constructor)]
    pub fn new(config_json: String) -> napi::Result<Self> {
        let config: Config = serde_json::from_str(&config_json).map_err(js_error)?;
        config.validate().map_err(js_error)?;
        let (sender, receiver) = mpsc::sync_channel(2);
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let (stopped_tx, stopped) = watch::channel(false);
        std::thread::Builder::new()
            .name("velocast-native-encoder".into())
            .spawn(move || {
                run_worker(config, receiver, cancel);
                let _ = stopped_tx.send(true);
            })
            .map_err(js_error)?;
        Ok(Self {
            ingress: Mutex::new(Ingress {
                sender,
                finishing: false,
            }),
            cancelled,
            stopped,
        })
    }

    #[napi]
    pub async fn ready(&self) -> napi::Result<String> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Command::Ready(tx), false)?;
        receive(rx).await
    }

    /// The caller must retain the Electron texture lease until this promise settles.
    #[napi]
    pub async fn encode_frame(&self, frame_json: String) -> napi::Result<String> {
        let frame = serde_json::from_str(&frame_json).map_err(js_error)?;
        let (tx, rx) = oneshot::channel();
        self.enqueue(Command::Frame(frame, tx), false)?;
        receive(rx).await
    }

    #[napi]
    pub async fn finish(&self) -> napi::Result<String> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Command::Finish(tx), true)?;
        receive(rx).await
    }

    #[napi]
    pub async fn abort(&self) -> napi::Result<()> {
        self.cancelled.store(true, Ordering::Release);
        let mut stopped = self.stopped.clone();
        while !*stopped.borrow_and_update() {
            if stopped.changed().await.is_err() {
                break;
            }
        }
        Ok(())
    }
}

impl NativeEncoder {
    fn enqueue(&self, command: Command, finish: bool) -> napi::Result<()> {
        let mut ingress = self.ingress.lock().map_err(js_error)?;
        if ingress.finishing || self.cancelled.load(Ordering::Acquire) {
            return Err(js_error("native encoder is closed"));
        }
        ingress
            .sender
            .try_send(command)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    js_error("native encoder queue is full (capacity 2)")
                }
                mpsc::TrySendError::Disconnected(_) => {
                    js_error("native encoder worker has stopped")
                }
            })?;
        ingress.finishing = finish;
        Ok(())
    }
}
impl Drop for NativeEncoder {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

async fn receive(rx: oneshot::Receiver<Result<String, String>>) -> napi::Result<String> {
    rx.await.map_err(js_error)?.map_err(js_error)
}

#[cfg(windows)]
fn run_worker(config: Config, receiver: mpsc::Receiver<Command>, cancelled: Arc<AtomicBool>) {
    let mut engine = match windows::Encoder::open(config) {
        Ok(engine) => Some(engine),
        Err(error) => {
            reject_until_close(
                receiver,
                cancelled,
                format!("native encoder initialization: {error:#}"),
            );
            return;
        }
    };
    let failure = loop {
        if cancelled.load(Ordering::Acquire) {
            break "native encoder aborted".to_string();
        }
        let command = match receiver.recv_timeout(std::time::Duration::from_millis(20)) {
            Ok(c) => c,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break "native encoder dropped".into(),
        };
        let enc = engine.as_mut().unwrap();
        let (result, reply, terminal) = match command {
            Command::Ready(reply) => (Ok(enc.report()), reply, false),
            Command::Frame(frame, reply) => (enc.encode(frame), reply, false),
            Command::Finish(reply) => (enc.finish(), reply, true),
        };
        let failed = result.is_err();
        let result = result.map_err(|e| format!("{e:#}"));
        let failure = result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(|| "native encoder finished".into());
        if terminal || failed {
            drop(engine.take());
        }
        let _ = reply.send(result);
        if terminal || failed {
            break failure;
        }
    };
    drop(engine);
    // Queue entries have never imported/copied their texture, so rejection is safe.
    while let Ok(command) = receiver.try_recv() {
        command.reject(&failure);
    }
}

#[cfg(not(windows))]
fn run_worker(_config: Config, receiver: mpsc::Receiver<Command>, cancelled: Arc<AtomicBool>) {
    reject_until_close(
        receiver,
        cancelled,
        "native NV12 encoding is supported only on Windows D3D11".into(),
    );
}

fn reject_until_close(
    receiver: mpsc::Receiver<Command>,
    cancelled: Arc<AtomicBool>,
    error: String,
) {
    // Preserve the initialization error for ready(), then stop. No graphics state exists.
    loop {
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        match receiver.recv_timeout(std::time::Duration::from_millis(20)) {
            Ok(command) => {
                command.reject(&error);
                while let Ok(command) = receiver.try_recv() {
                    command.reject(&error);
                }
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (NativeEncoder, mpsc::Receiver<Command>, watch::Sender<bool>) {
        let (sender, receiver) = mpsc::sync_channel(2);
        let (stopped_tx, stopped) = watch::channel(false);
        (
            NativeEncoder {
                ingress: Mutex::new(Ingress {
                    sender,
                    finishing: false,
                }),
                cancelled: Arc::new(AtomicBool::new(false)),
                stopped,
            },
            receiver,
            stopped_tx,
        )
    }

    #[test]
    fn queue_overflow_does_not_close_admission() {
        let (encoder, receiver, _stopped) = fixture();
        for _ in 0..2 {
            let (reply, _rx) = oneshot::channel();
            encoder.enqueue(Command::Ready(reply), false).unwrap();
        }
        let (reply, _rx) = oneshot::channel();
        assert!(encoder.enqueue(Command::Finish(reply), true).is_err());
        receiver.recv().unwrap();
        let (reply, _rx) = oneshot::channel();
        encoder.enqueue(Command::Ready(reply), false).unwrap();
    }

    #[test]
    fn finish_and_drop_close_admission_without_blocking() {
        let (encoder, _receiver, _stopped) = fixture();
        let (reply, _rx) = oneshot::channel();
        encoder.enqueue(Command::Finish(reply), true).unwrap();
        let (reply, _rx) = oneshot::channel();
        assert!(encoder.enqueue(Command::Ready(reply), false).is_err());
        let cancelled = encoder.cancelled.clone();
        drop(encoder);
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn abort_waits_for_native_cleanup() {
        let (encoder, _receiver, stopped) = fixture();
        let cancelled = encoder.cancelled.clone();
        let abort = tokio::spawn(async move { encoder.abort().await });
        tokio::task::yield_now().await;
        assert!(cancelled.load(Ordering::Acquire));
        assert!(!abort.is_finished());
        stopped.send(true).unwrap();
        abort.await.unwrap().unwrap();
    }
}
