use super::*;

#[test]
fn parses_model_id() {
    assert_eq!(
        MODEL_ID.parse::<AppleSpeechModel>().unwrap(),
        AppleSpeechModel::Default
    );
    assert!("soniqo-parakeet-batch".parse::<AppleSpeechModel>().is_err());
}

#[test]
fn local_model_requires_matching_base_url() {
    assert!(local_model_from_request(LOCAL_BASE_URL, MODEL_ID).is_some());
    assert!(local_model_from_request("soniqo://local", MODEL_ID).is_none());
    assert!(local_model_from_request(LOCAL_BASE_URL, "whisper-tiny").is_none());
}

#[test]
fn locale_matching_widens_only_for_bare_language_tags() {
    assert!(locale_matches("en-US", "en"));
    assert!(locale_matches("en-US", "en-US"));
    assert!(locale_matches("en-US", "EN-us"));
    assert!(!locale_matches("en-US", "en-GB"));
    assert!(!locale_matches("ko-KR", "en"));
}

#[test]
fn session_locale_requires_a_system_settings_language() {
    // Off macOS there are no preferred locales, so nothing resolves.
    if !cfg!(target_os = "macos") {
        let korean: anlg_language::Language = "ko".parse().unwrap();
        assert_eq!(resolve_session_locale(&[korean]), None);
        return;
    }

    let Ok(preferred) = preferred_locales() else {
        return;
    };

    // A language the user has not added never resolves, whatever Apple supports.
    let unsupported: anlg_language::Language = "hi".parse().unwrap();
    assert_eq!(resolve_session_locale(&[unsupported]), None);

    if let Some(first) = preferred.first() {
        let base = first.split('-').next().unwrap();
        let language: anlg_language::Language = base.parse().unwrap();
        assert_eq!(
            resolve_session_locale(&[language]).as_deref(),
            Some(first.as_str())
        );

        // No requested language falls back to the primary System Settings language.
        assert_eq!(resolve_session_locale(&[]).as_deref(), Some(first.as_str()));
        assert_eq!(settings_locale().unwrap(), *first);
    }
}

#[test]
fn settings_locale_requires_macos_system_languages() {
    if !cfg!(target_os = "macos") {
        assert!(matches!(settings_locale(), Err(Error::UnsupportedPlatform)));
    }
}

#[test]
fn final_partials_keep_native_word_timings() {
    let partial = LivePartial {
        source: "system".to_string(),
        text: "hello world".to_string(),
        is_final: true,
        start: 1.0,
        end: 2.0,
        words: vec![
            Word {
                text: "hello".to_string(),
                start: 1.0,
                end: 1.4,
                confidence: Some(0.9),
            },
            Word {
                text: "world".to_string(),
                start: 1.5,
                end: 2.0,
                confidence: None,
            },
        ],
    };

    let stream::StreamResponse::TranscriptResponse {
        channel,
        channel_index,
        ..
    } = partial.into_stream_response()
    else {
        panic!("expected transcript response");
    };

    let words = &channel.alternatives[0].words;
    assert_eq!(channel_index, vec![1, 2]);
    assert_eq!(words.len(), 2);
    assert_eq!(words[0].start, 1.0);
    assert_eq!(words[0].end, 1.4);
    assert_eq!(words[0].confidence, 0.9);
    assert_eq!(words[1].start, 1.5);
    assert_eq!(words[1].confidence, 1.0);
}

#[test]
fn finalized_partials_that_lost_characters_fall_back_to_the_full_text() {
    // What the bridge used to emit when it dropped an untimed run mid-word:
    // the alternative's transcript was intact but the words were not.
    let partial = LivePartial {
        source: "system".to_string(),
        text: "une intégration complète".to_string(),
        is_final: true,
        start: 0.0,
        end: 3.0,
        words: vec![
            Word {
                text: "une".to_string(),
                start: 0.0,
                end: 1.0,
                confidence: Some(0.9),
            },
            Word {
                text: "ingration".to_string(),
                start: 1.0,
                end: 2.0,
                confidence: Some(0.4),
            },
            Word {
                text: "complète".to_string(),
                start: 2.0,
                end: 3.0,
                confidence: Some(0.9),
            },
        ],
    };

    let stream::StreamResponse::TranscriptResponse { channel, .. } = partial.into_stream_response()
    else {
        panic!("expected transcript response");
    };

    let words = &channel.alternatives[0].words;
    assert_eq!(
        words
            .iter()
            .map(|word| word.word.as_str())
            .collect::<Vec<_>>(),
        vec!["une", "intégration", "complète"]
    );
}

#[test]
fn finalized_partials_keep_native_timings_when_nothing_was_lost() {
    let partial = LivePartial {
        source: "system".to_string(),
        text: "une intégration complète".to_string(),
        is_final: true,
        start: 0.0,
        end: 3.0,
        words: vec![
            Word {
                text: "une".to_string(),
                start: 0.0,
                end: 0.4,
                confidence: Some(0.9),
            },
            Word {
                text: "intégration".to_string(),
                start: 0.4,
                end: 2.2,
                confidence: Some(0.8),
            },
            Word {
                text: "complète".to_string(),
                start: 2.2,
                end: 3.0,
                confidence: Some(0.9),
            },
        ],
    };

    let stream::StreamResponse::TranscriptResponse { channel, .. } = partial.into_stream_response()
    else {
        panic!("expected transcript response");
    };

    let words = &channel.alternatives[0].words;
    assert_eq!(words.len(), 3);
    assert_eq!(words[1].start, 0.4);
    assert_eq!(words[1].end, 2.2);
    assert_eq!(words[1].confidence, 0.8);
}

#[test]
fn word_coverage_ignores_whitespace_only_differences() {
    let words = vec![
        Word {
            text: " hello".to_string(),
            start: 0.0,
            end: 1.0,
            confidence: None,
        },
        Word {
            text: "world ".to_string(),
            start: 1.0,
            end: 2.0,
            confidence: None,
        },
    ];

    assert!(words_cover_text(&words, "hello world"));
    assert!(!words_cover_text(&words, "hello cruel world"));
    assert!(!words_cover_text(&words, "hello wold"));
}

#[test]
fn volatile_partials_synthesize_word_timings() {
    let partial = LivePartial {
        source: "microphone".to_string(),
        text: "one two".to_string(),
        is_final: false,
        start: 0.0,
        end: 1.0,
        words: vec![],
    };

    let stream::StreamResponse::TranscriptResponse { channel, .. } = partial.into_stream_response()
    else {
        panic!("expected transcript response");
    };

    let words = &channel.alternatives[0].words;
    assert_eq!(words.len(), 2);
    assert_eq!(words[0].start, 0.0);
    assert_eq!(words[1].start, 0.5);
}

#[test]
fn batch_response_reports_native_timing_source() {
    let response = batch_response_from_transcripts(vec![FileTranscript {
        text: "hello  world".to_string(),
        duration_seconds: 2.0,
        words: vec![
            Word {
                text: "hello".to_string(),
                start: 0.0,
                end: 0.5,
                confidence: Some(0.8),
            },
            Word {
                text: "world".to_string(),
                start: 0.5,
                end: 1.2,
                confidence: Some(0.7),
            },
        ],
    }]);

    let alternative = &response.results.channels[0].alternatives[0];
    assert_eq!(alternative.transcript, "hello world");
    assert_eq!(response.metadata["timing_source"], "native");
    assert_eq!(response.metadata["duration"], 2.0);
    assert_eq!(alternative.words.len(), 2);
    assert_eq!(alternative.words[1].start, 0.5);
    assert_eq!(alternative.words[1].end, 1.2);
}

#[test]
fn batch_channels_that_lost_characters_fall_back_to_the_full_text() {
    let response = batch_response_from_transcripts(vec![FileTranscript {
        text: "une intégration complète".to_string(),
        duration_seconds: 3.0,
        words: vec![
            Word {
                text: "une".to_string(),
                start: 0.0,
                end: 1.0,
                confidence: Some(0.9),
            },
            Word {
                text: "ingration".to_string(),
                start: 1.0,
                end: 2.0,
                confidence: Some(0.4),
            },
            Word {
                text: "complète".to_string(),
                start: 2.0,
                end: 3.0,
                confidence: Some(0.9),
            },
        ],
    }]);

    let alternative = &response.results.channels[0].alternatives[0];
    assert_eq!(
        alternative
            .words
            .iter()
            .map(|word| word.word.as_str())
            .collect::<Vec<_>>(),
        vec!["une", "intégration", "complète"]
    );
    assert!(alternative.words.iter().all(|word| word.channel == 0));
}
