use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum SignalingMessage {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_mline_index: Option<u16>,
    },
}

pub struct SignalingHandler;

impl SignalingHandler {
    pub fn parse_message(payload: &str) -> Result<SignalingMessage, serde_json::Error> {
        serde_json::from_str(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_offer_and_answer_with_sdp_strings() {
        assert_eq!(
            SignalingHandler::parse_message(r#"{"type":"offer","sdp":"offer-sdp"}"#).unwrap(),
            SignalingMessage::Offer {
                sdp: "offer-sdp".to_string(),
            }
        );
        assert_eq!(
            SignalingHandler::parse_message(r#"{"type":"answer","sdp":"answer-sdp"}"#).unwrap(),
            SignalingMessage::Answer {
                sdp: "answer-sdp".to_string(),
            }
        );
    }

    #[test]
    fn parses_trickled_candidate_fields() {
        assert_eq!(
            SignalingHandler::parse_message(
                r#"{"type":"candidate","candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}"#
            )
            .unwrap(),
            SignalingMessage::Candidate {
                candidate: "candidate:1".to_string(),
                sdp_mid: Some("0".to_string()),
                sdp_mline_index: Some(0),
            }
        );
    }
}
