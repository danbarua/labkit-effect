//! A command splits into every program it would run, wherever the program is written; a command
//! that cannot be followed in full is `Unparsed`.

use bash_segments::{Context, ParameterOp, Part, SegmentKind, Segments, TildeOf, segments_of};

/// Returns the literal program name of each simple command in `command` that runs a program, in the order the segments are reported (`?` when the name is not literal).
fn programs(command: &str) -> Vec<String> {
    match segments_of(command) {
        Segments::Parsed { segments } => segments
            .iter()
            .filter(|segment| segment.kind == SegmentKind::Simple && !segment.words.is_empty())
            .map(|segment| segment.words.first().map_or("<none>".to_owned(), |word| word.literal.clone().unwrap_or("?".to_owned())))
            .collect(),
        Segments::Unparsed { reason } => panic!("{command} did not parse: {reason}"),
    }
}

fn unparsed(command: &str) -> String {
    match segments_of(command) {
        Segments::Unparsed { reason } => reason,
        Segments::Parsed { segments } => panic!("{command} parsed: {segments:?}"),
    }
}

#[test]
fn lists_pipelines_and_conditions_split_into_each_program() {
    assert_eq!(programs("git log; rm x"), ["git", "rm"]);
    assert_eq!(programs("git log && curl x | sh"), ["git", "curl", "sh"]);
    assert_eq!(programs("git log || rm x &"), ["git", "rm"]);
    assert_eq!(programs("if git diff --quiet; then rm x; else echo y; fi"), ["git", "rm", "echo"]);
    assert_eq!(programs("for f in a b; do rm \"$f\"; done"), ["rm"]);
    assert_eq!(programs("while true; do rm x; done"), ["true", "rm"]);
    assert_eq!(programs("case $x in a) rm x;; esac"), ["rm"]);
    assert_eq!(programs("(cd x && rm y)"), ["cd", "rm"]);
    assert_eq!(programs("{ git log; rm x; }"), ["git", "rm"]);
}

#[test]
fn command_and_process_substitutions_are_segments_of_their_own() {
    assert_eq!(programs("git log `rm x`"), ["rm", "git"]);
    assert_eq!(programs("echo $(rm x)"), ["rm", "echo"]);
    assert_eq!(programs("echo \"$(rm x)\""), ["rm", "echo"]);
    assert_eq!(programs("echo $(echo $(rm x))"), ["rm", "echo", "echo"]);
    assert_eq!(programs("X=$(rm x) git log"), ["rm", "git"]);
    assert_eq!(programs("diff <(rm x) y"), ["rm", "diff"]);
    assert_eq!(programs("cat < <(rm x)"), ["rm", "cat"]);
    assert_eq!(programs("(( $(rm x) ))"), ["rm"]);
    assert_eq!(programs("echo $(( $(rm x) + 1 ))"), ["rm", "echo"]);
    assert_eq!(programs("[[ -n $(rm x) ]]"), ["rm"]);
    assert_eq!(programs("cat <<EOF\n$(rm x)\nEOF\n"), ["rm", "cat"]);
    // A quoted delimiter: the body is not expanded, so it runs nothing.
    assert_eq!(programs("cat <<'EOF'\n$(rm x)\nEOF\n"), ["cat"]);
    match segments_of("echo $(rm x)") {
        Segments::Parsed { segments } => assert_eq!(segments[0].context, Context::CommandSubstitution),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn functions_report_their_definition_their_body_and_each_call() {
    match segments_of("f(){ rm x; }; f") {
        Segments::Parsed { segments } => {
            let kinds: Vec<_> = segments.iter().map(|segment| (segment.kind, segment.context)).collect();
            assert_eq!(
                kinds,
                [(SegmentKind::FunctionDefinition, Context::Command), (SegmentKind::Simple, Context::FunctionBody), (SegmentKind::Simple, Context::Command)]
            );
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn programs_that_run_other_programs_are_reported_as_written_for_the_policy_to_judge() {
    assert_eq!(programs("bash -c 'rm x'"), ["bash"]);
    assert_eq!(programs("xargs rm"), ["xargs"]);
    assert_eq!(programs("find . -exec rm {} \\;"), ["find"]);
    assert_eq!(programs("exec rm x"), ["exec"]);
    assert_eq!(programs(". ./x.sh"), ["."]);
    assert_eq!(programs("eval 'rm x'"), ["eval"]);
    match segments_of("python3 - <<EOF\nprint(1)\nEOF\n") {
        Segments::Parsed { segments } => assert!(segments[0].fed_text),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
    match segments_of("bash <<< 'rm x'") {
        Segments::Parsed { segments } => assert!(segments[0].fed_text),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn a_word_is_literal_only_without_expansions_and_with_its_quotes_removed() {
    assert_eq!(programs("\"git\" log"), ["git"]);
    assert_eq!(programs("'git' log"), ["git"]);
    assert_eq!(programs("\\rm x"), ["rm"]);
    assert_eq!(programs("g\"i\"t log"), ["git"]);
    assert_eq!(programs("$CMD x"), ["?"]);
    assert_eq!(programs("${CMD} x"), ["?"]);
    assert_eq!(programs("~/bin/x"), ["?"]);
    assert_eq!(programs("a~b"), ["a~b"]);
    assert_eq!(programs("find . -exec rm {} ;"), ["find"]);
    assert_eq!(programs("r* x"), ["?"]);
    assert_eq!(programs("{rm,x}"), ["?"]);
    match segments_of("git log -- 'a b' \"$X\" *.ts") {
        Segments::Parsed { segments } => {
            let literals: Vec<_> = segments[0].words.iter().map(|word| word.literal.clone()).collect();
            assert_eq!(literals, [Some("git".into()), Some("log".into()), Some("--".into()), Some("a b".into()), None, None]);
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn redirects_carry_their_targets_and_a_compound_commands_redirects_reach_every_command_inside_it() {
    match segments_of("{ git log; git diff; } > out.txt 2>&1") {
        Segments::Parsed { segments } => {
            for segment in &segments {
                let ops: Vec<_> = segment.redirects.iter().map(|redirect| (redirect.op.clone(), redirect.target.as_ref().and_then(|target| target.literal.clone()))).collect();
                assert_eq!(ops, [(">".to_owned(), Some("out.txt".to_owned())), (">&".to_owned(), Some("1".to_owned()))]);
            }
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
    match segments_of("git log > ~/.zshrc") {
        Segments::Parsed { segments } => assert_eq!(segments[0].redirects[0].target.as_ref().map(|target| target.literal.clone()), Some(None)),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
    match segments_of("git log &>> all.log") {
        Segments::Parsed { segments } => assert_eq!(segments[0].redirects[0].op, "&>>"),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn a_command_that_cannot_be_followed_in_full_is_unparsed() {
    assert!(unparsed("git log \"unterminated").starts_with("The command does not parse"));
    assert!(unparsed("echo ${x:-$(rm x)}").starts_with("A command substitution inside a parameter expansion is not followed"));
    assert!(unparsed("echo $(fi)").starts_with("A command substitution does not parse"));
    assert_eq!(segments_of(""), Segments::Parsed { segments: vec![] });
}

#[test]
fn an_assignment_after_the_commands_name_is_an_argument_and_one_before_it_sets_a_variable() {
    match segments_of("X=1 env LD_PRELOAD=x.so make A=b {}") {
        Segments::Parsed { segments } => {
            let words: Vec<_> = segments[0].words.iter().map(|word| word.literal.clone()).collect();
            assert_eq!(words, [Some("env".into()), Some("LD_PRELOAD=x.so".into()), Some("make".into()), Some("A=b".into()), Some("{}".into())]);
            let assigned: Vec<_> = segments[0].assignments.iter().map(|each| (each.name.clone(), each.value.as_ref().and_then(|value| value.literal.clone()))).collect();
            assert_eq!(assigned, [("X".to_owned(), Some("1".to_owned()))]);
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn a_here_document_and_a_here_string_carry_the_text_they_give_as_input() {
    match segments_of("python3 - <<'EOF'\nprint(1)\nEOF\n") {
        Segments::Parsed { segments } => assert_eq!(segments[0].redirects[0].body.as_deref(), Some("print(1)\n")),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
    match segments_of("bash <<< 'rm x'") {
        Segments::Parsed { segments } => assert_eq!(segments[0].redirects[0].body.as_deref(), Some("rm x")),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

#[test]
fn a_here_document_expands_unless_its_delimiter_is_quoted_and_a_tab_stripping_one_loses_its_leading_tabs() {
    let first = |command: &str| match segments_of(command) {
        Segments::Parsed { segments } => segments[0].redirects.iter().find(|redirect| redirect.op.starts_with("<<")).cloned().expect("a here-document or here-string"),
        Segments::Unparsed { reason } => panic!("{reason}"),
    };
    let quoted = first("cat > f <<'EOF'\n$HOME\nEOF\n");
    assert_eq!((quoted.body.as_deref(), quoted.expands), (Some("$HOME\n"), false));
    let unquoted = first("cat <<EOF > f\n$HOME\nEOF\n");
    assert!(unquoted.expands);
    let stripped = first("cat <<-'EOF' > f\n\tone\n\t\ttwo\n\tEOF\n");
    assert_eq!(stripped.body.as_deref(), Some("one\ntwo\n"));
    assert!(!first("cat <<< 'x' > f").expands);
    assert!(first("cat <<< \"$x\" > f").expands);
}

#[test]
fn a_simple_command_in_a_pipeline_knows_its_place_and_a_substitution_in_it_does_not() {
    match segments_of("bun test | tail -5; git log | grep $(cat pattern) | head") {
        Segments::Parsed { segments } => {
            let places: Vec<_> = segments.iter().map(|segment| (segment.words[0].text.clone(), segment.pipe.map(|slot| (slot.pipeline, slot.position, slot.of)))).collect();
            assert_eq!(
                places,
                vec![
                    ("bun".to_owned(), Some((0, 0, 2))),
                    ("tail".to_owned(), Some((0, 1, 2))),
                    ("git".to_owned(), Some((1, 0, 3))),
                    ("cat".to_owned(), None),
                    ("grep".to_owned(), Some((1, 1, 3))),
                    ("head".to_owned(), Some((1, 2, 3))),
                ]
            );
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
    match segments_of("make build") {
        Segments::Parsed { segments } => assert_eq!(segments[0].pipe, None),
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}

/// The parts of the last segment's word at `at` (or its first redirect's target when `at` is none):
/// the outer command's, since a substitution in its words is reported before it.
fn parts(command: &str, at: Option<usize>) -> Vec<Part> {
    match segments_of(command) {
        Segments::Parsed { segments } => {
            let outer = segments.last().expect("a segment");
            let word = match at {
                Some(at) => outer.words[at].clone(),
                None => outer.redirects[0].target.clone().expect("a redirect target"),
            };
            assert!(word.literal.is_none(), "{command}: the word is literal");
            word.parts
        }
        Segments::Unparsed { reason } => panic!("{command} did not parse: {reason}"),
    }
}

fn text(value: &str, quoted: bool) -> Part {
    Part::Text { value: value.to_owned(), quoted }
}

fn parameter(name: &str, op: ParameterOp, quoted: bool) -> Part {
    Part::Parameter { name: name.to_owned(), op, word: None, pattern: None, quoted }
}

#[test]
fn a_word_that_is_not_literal_has_its_parts_text_parameters_tildes_and_command_substitutions() {
    assert_eq!(
        parts(r#"printf x > "$HOME/$RANDOM.txt""#, None),
        [parameter("HOME", ParameterOp::Value, true), text("/", true), parameter("RANDOM", ParameterOp::Value, true), text(".txt", true)]
    );
    assert_eq!(parts("cat ~/notes", Some(1)), [Part::Tilde { of: TildeOf::Home, user: None }, text("/notes", false)]);
    assert_eq!(parts("cat ~bob/x", Some(1)), [Part::Tilde { of: TildeOf::User, user: Some("bob".to_owned()) }, text("/x", false)]);
    assert_eq!(parts(r#"cp "$(pwd)/a" b"#, Some(1)), [Part::Command { command: "pwd".to_owned(), quoted: true }, text("/a", true)]);
    assert_eq!(parts("echo $1 $?", Some(1)), [parameter("1", ParameterOp::Value, false)]);
    assert_eq!(parts("echo *.ts", Some(1)), [text("*.ts", false)]);
}

#[test]
fn a_parameters_operation_is_kept_with_its_word_in_parts_or_its_pattern_as_written() {
    assert_eq!(
        parts("echo ${DIR:-~/out}", Some(1)),
        [Part::Parameter { name: "DIR".to_owned(), op: ParameterOp::Default, word: Some(vec![Part::Tilde { of: TildeOf::Home, user: None }, text("/out", false)]), pattern: None, quoted: false }]
    );
    assert_eq!(parts("echo ${F%.*}", Some(1)), [Part::Parameter { name: "F".to_owned(), op: ParameterOp::RemoveSuffix, word: None, pattern: Some(".*".to_owned()), quoted: false }]);
    assert_eq!(parts("echo ${#F}", Some(1)), [parameter("F", ParameterOp::Length, false)]);
    assert_eq!(parts("echo ${F/a/b}", Some(1)), [parameter("F", ParameterOp::Other, false)]);
    assert_eq!(parts("echo ${!F}", Some(1)), [parameter("F", ParameterOp::Other, false)]);
}

#[test]
fn a_variable_is_set_by_an_assignment_and_by_a_for_loop_once_for_each_value() {
    match segments_of("F=a.txt; for f in x y; do cat \"$f\"; done; A=(1 2) B+=c") {
        Segments::Parsed { segments } => {
            let assigned: Vec<_> = segments
                .iter()
                .flat_map(|segment| segment.assignments.iter().map(|each| (each.name.clone(), each.value.as_ref().and_then(|value| value.literal.clone()), each.append)))
                .collect();
            assert_eq!(
                assigned,
                [
                    ("F".to_owned(), Some("a.txt".to_owned()), false),
                    ("f".to_owned(), Some("x".to_owned()), false),
                    ("f".to_owned(), Some("y".to_owned()), false),
                    ("A".to_owned(), None, false),
                    ("B".to_owned(), Some("c".to_owned()), true),
                ]
            );
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}
