//! A command splits into every program it would run, wherever the program is written; a command
//! that cannot be followed in full is `Unparsed`.

use bash_segments::{Context, SegmentKind, Segments, segments_of};

/// Returns the literal program name of each simple command in `command`, in the order the segments are reported (`?` when the name is not literal).
fn programs(command: &str) -> Vec<String> {
    match segments_of(command) {
        Segments::Parsed { segments } => segments
            .iter()
            .filter(|segment| segment.kind == SegmentKind::Simple)
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
            assert_eq!(segments[0].assignments, ["X=1"]);
        }
        Segments::Unparsed { reason } => panic!("{reason}"),
    }
}
