use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy)]
pub struct InputPayload {
    pub slot: u8,
    pub bitmask: u8,
    pub state: u8,
}

impl InputPayload {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != 3 {
            return Err("Invalid payload length: must be exactly 3 bytes".to_string());
        }
        if bytes[2] > 1 {
            return Err("Invalid input state: expected 0 (released) or 1 (pressed)".to_string());
        }

        Ok(Self {
            slot: bytes[0],
            bitmask: bytes[1],
            state: bytes[2],
        })
    }
}

pub struct InputDemuxer {
    tx: mpsc::Sender<InputPayload>,
    rx: mpsc::Receiver<InputPayload>,
}

impl InputDemuxer {
    pub fn new(capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel(capacity);
        Self { tx, rx }
    }

    pub fn get_sender(&self) -> mpsc::Sender<InputPayload> {
        self.tx.clone()
    }

    pub async fn push_raw_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let payload = InputPayload::from_bytes(bytes)?;
        self.tx
            .send(payload)
            .await
            .map_err(|error| format!("Failed to queue input frame: {error}"))
    }

    pub fn drain_to_ports(&mut self, controller_ports: &mut [u16; 4]) {
        while let Ok(message) = self.rx.try_recv() {
            let slot = message.slot as usize;
            if slot < controller_ports.len() {
                if message.state == 0x01 {
                    controller_ports[slot] |= message.bitmask as u16;
                } else {
                    controller_ports[slot] &= !(message.bitmask as u16);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_press_and_release_into_the_selected_port() {
        let mut demuxer = InputDemuxer::new(2);
        let sender = demuxer.get_sender();
        sender
            .try_send(InputPayload {
                slot: 1,
                bitmask: 0x10,
                state: 1,
            })
            .unwrap();

        let mut ports = [0; 4];
        demuxer.drain_to_ports(&mut ports);
        assert_eq!(ports, [0, 0x10, 0, 0]);

        sender
            .try_send(InputPayload {
                slot: 1,
                bitmask: 0x10,
                state: 0,
            })
            .unwrap();

        demuxer.drain_to_ports(&mut ports);
        assert_eq!(ports, [0; 4]);
    }

    #[test]
    fn rejects_payloads_that_are_not_three_bytes() {
        assert!(InputPayload::from_bytes(&[0, 0]).is_err());
        assert!(InputPayload::from_bytes(&[0, 0, 1, 0]).is_err());
    }
}
