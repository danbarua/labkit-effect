//! Splits a shell command into its segments: every simple command it would run, wherever it is in
//! the command (a pipeline, a `;` or `&&` list, a subshell, a function's body, a loop, a condition, a
//! command substitution or a process substitution), with its words, its redirects, and whether its
//! input is a here-document or a here-string.
//!
//! The walk is adapted from exo-project's structural profiler (spike 01_2). It reports structure
//! only: each word's parts (text, `~`, a parameter and what is done to it, a command substitution),
//! and each variable a command sets. Working out what a segment does, and what its words expand to,
//! is the harness's (`src/agent-environment`); deciding what it may do is the permission policy's.
//!
//! It fails closed. When any part of a command cannot be followed, the whole command is `Unparsed`
//! with the reason, rather than split without that part: a tokenizer or parser error; a word that
//! does not parse; a command substitution that does not parse; a command substitution inside a
//! parameter expansion; a here-document body with a command substitution that does not parse.
//!
//! The command is parsed as bash (not POSIX sh), a superset of what `sh -c` accepts.

use brush_parser::ast::{
    self, AndOr, AssignmentValue, Command, CommandPrefixOrSuffixItem, CompoundCommand, CompoundList, ExtendedTestExpr,
    IoFileRedirectKind, IoFileRedirectTarget, IoRedirect, Pipeline, Program, SimpleCommand,
};
use brush_parser::word::{self, Parameter, ParameterExpr, ParameterTestType, SpecialParameter, TildeExpr, WordPiece, WordPieceWithSource};
use serde::Serialize;

/// The result for one command.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "_tag")]
pub enum Segments {
    Parsed { segments: Vec<Segment> },
    Unparsed { reason: String },
}

/// One simple command, a function's definition, or a test, and where it runs.
#[derive(Debug, Serialize, PartialEq)]
pub struct Segment {
    pub kind: SegmentKind,
    /// The program and its arguments, as written. Empty for a command that only assigns variables.
    pub words: Vec<WordOut>,
    /// The variables set for this command alone (`NAME=value cmd`), or in the shell when there are no
    /// words; for a `for` loop, one for each value its variable takes.
    pub assignments: Vec<Assigned>,
    /// Its own redirects, then those of each compound command it is inside, innermost first.
    pub redirects: Vec<Redirect>,
    /// Whether its standard input is a here-document or a here-string, written in the command.
    pub fed_text: bool,
    pub context: Context,
    /// Its place in a pipeline of two commands or more, when it is one of them (`a | b`); a command
    /// inside a compound command or a substitution in a pipeline has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipe: Option<PipeSlot>,
}

/// A simple command's place in a pipeline: which pipeline of the command (counted from 0, in the
/// order they are written), its position in it (from 0), and how many commands the pipeline has.
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
pub struct PipeSlot {
    pub pipeline: u32,
    pub position: u32,
    pub of: u32,
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum SegmentKind {
    Simple,
    FunctionDefinition,
    Test,
    Arithmetic,
}

/// Where a segment runs.
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Context {
    Command,
    Subshell,
    FunctionBody,
    CommandSubstitution,
    ProcessSubstitution,
}

/// A word: its text as written, its value when that is a literal string, and otherwise its parts.
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct WordOut {
    pub text: String,
    /// The word's value with its quotes and escapes removed, when it has no expansion of any kind:
    /// no parameter, command or arithmetic expansion, no tilde, and no unquoted glob or brace
    /// characters. Otherwise absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
    /// The word's parts, in order, when it has no literal value.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<Part>,
}

/// A variable a command sets: its name, its value as a word (absent when it is an array or a loop
/// over the positional parameters), and whether the value is appended (`NAME+=value`).
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct Assigned {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<WordOut>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub append: bool,
}

/// A part of a word, as the shell expands it. `quoted` when it is inside quotes, so that the shell
/// neither splits nor globs it.
#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    /// Text: its value, with quotes and escapes removed.
    Text {
        value: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        quoted: bool,
    },
    /// A tilde: the home folder (`~`), a user's (`~user`), the working folder (`~+`), the previous one
    /// (`~-`), or a folder of the stack (`~1`).
    Tilde {
        of: TildeOf,
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<String>,
    },
    /// A parameter expansion: the parameter's name (`HOME`, `1`, `?`, `@`), what is done to its value
    /// (`op`), and that operation's word, in parts (a default, an alternative), or its pattern, as
    /// written (what a removal removes).
    Parameter {
        name: String,
        op: ParameterOp,
        #[serde(skip_serializing_if = "Option::is_none")]
        word: Option<Vec<Part>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        quoted: bool,
    },
    /// A command substitution: the command, as written. Its segments are reported with the command's.
    Command {
        command: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        quoted: bool,
    },
    /// An arithmetic expansion, as written.
    Arithmetic {
        expression: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        quoted: bool,
    },
}

/// Which folder a tilde names.
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum TildeOf {
    Home,
    User,
    Working,
    Previous,
    Stack,
}

/// What a parameter expansion does to the parameter's value: `value` (`$V`, `${V}`); a default
/// (`${V:-w}`, `${V-w}` when unset only), an assignment of one (`${V:=w}`, `${V=w}`), an alternative
/// (`${V:+w}`, `${V+w}`), an error (`${V:?w}`); its length (`${#V}`); a pattern removed from its end
/// (`${V%p}`, `${V%%p}`) or its start (`${V#p}`, `${V##p}`); or `other` (an indirection, an index, a
/// substring, a replacement, a case change, a transform).
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ParameterOp {
    Value,
    Default,
    DefaultIfUnset,
    Assign,
    AssignIfUnset,
    Alternative,
    AlternativeIfUnset,
    Error,
    Length,
    RemoveSuffix,
    RemoveLongestSuffix,
    RemovePrefix,
    RemoveLongestPrefix,
    Other,
}

/// A redirect: its operator, the file descriptor it names, and its target.
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct Redirect {
    /// `<`, `>`, `>>`, `<>`, `>|`, `<&`, `>&`, `&>`, `&>>`, `<<` (here-document) or `<<<` (here-string).
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fd: Option<i32>,
    /// The file or descriptor written to or read from; absent for here-documents, here-strings and process substitutions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<WordOut>,
    /// The text a here-document or here-string gives as input, as written; a `<<-` here-document's
    /// lines without their leading tabs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Whether the shell expands that text before giving it (`$x`, `` `cmd` ``): a here-document whose
    /// delimiter is not quoted, or a here-string that is not a literal word.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub expands: bool,
}

/// Returns the segments of `command`.
pub fn segments_of(command: &str) -> Segments {
    match parse(command) {
        Err(reason) => Segments::Unparsed { reason },
        Ok(program) => {
            let mut walker = Walker::default();
            walker.program(&program);
            match walker.failed {
                Some(reason) => Segments::Unparsed { reason },
                None => Segments::Parsed { segments: walker.segments },
            }
        }
    }
}

fn parser_options() -> brush_parser::ParserOptions {
    brush_parser::ParserOptions {
        sh_mode: false,
        posix_mode: false,
        enable_extended_globbing: true,
        tilde_expansion_at_word_start: true,
        tilde_expansion_after_colon: true,
        ..Default::default()
    }
}

fn parse(command: &str) -> Result<Program, String> {
    let tokens = brush_parser::tokenize_str(command).map_err(|error| format!("The command does not parse: {error}"))?;
    if tokens.is_empty() {
        return Ok(Program { complete_commands: vec![] });
    }
    brush_parser::parse_tokens(&tokens, &parser_options()).map_err(|error| format!("The command does not parse: {error}"))
}

#[derive(Default)]
struct Walker {
    segments: Vec<Segment>,
    /// The redirects of the compound commands being walked, innermost last.
    inherited: Vec<Vec<Redirect>>,
    context: Vec<Context>,
    failed: Option<String>,
    /// How many pipelines of two commands or more have been walked.
    pipelines: u32,
    /// The place of the simple command about to be walked, when it is in such a pipeline.
    pending_pipe: Option<PipeSlot>,
}

impl Walker {
    fn fail(&mut self, reason: String) {
        if self.failed.is_none() {
            self.failed = Some(reason);
        }
    }

    fn context(&self) -> Context {
        self.context.last().copied().unwrap_or(Context::Command)
    }

    fn within<F: FnOnce(&mut Self)>(&mut self, context: Context, walk: F) {
        self.context.push(context);
        walk(self);
        self.context.pop();
    }

    fn emit(&mut self, kind: SegmentKind, words: Vec<WordOut>, assignments: Vec<Assigned>, mut redirects: Vec<Redirect>, pipe: Option<PipeSlot>) {
        for outer in self.inherited.iter().rev() {
            redirects.extend(outer.iter().cloned());
        }
        let fed_text = redirects.iter().any(|redirect| redirect.op == "<<" || redirect.op == "<<<");
        let context = self.context();
        self.segments.push(Segment { kind, words, assignments, redirects, fed_text, context, pipe });
    }

    fn program(&mut self, program: &Program) {
        for list in &program.complete_commands {
            self.compound_list(list);
        }
    }

    fn compound_list(&mut self, list: &CompoundList) {
        for item in &list.0 {
            self.and_or(&item.0);
        }
    }

    fn and_or(&mut self, list: &ast::AndOrList) {
        self.pipeline(&list.first);
        for additional in &list.additional {
            match additional {
                AndOr::And(pipeline) | AndOr::Or(pipeline) => self.pipeline(pipeline),
            }
        }
    }

    fn pipeline(&mut self, pipeline: &Pipeline) {
        let of = pipeline.seq.len() as u32;
        let id = self.pipelines;
        if of >= 2 {
            self.pipelines += 1;
        }
        for (position, command) in pipeline.seq.iter().enumerate() {
            if of >= 2 && matches!(command, Command::Simple(_)) {
                self.pending_pipe = Some(PipeSlot { pipeline: id, position: position as u32, of });
            }
            self.command(command);
            self.pending_pipe = None;
        }
    }

    fn command(&mut self, command: &Command) {
        match command {
            Command::Simple(simple) => self.simple(simple),
            Command::Compound(compound, redirects) => {
                let own = redirects.as_ref().map(|list| self.redirects(&list.0)).unwrap_or_default();
                self.inherited.push(own);
                self.compound(compound);
                self.inherited.pop();
            }
            Command::Function(definition) => {
                let name = self.word(&definition.fname);
                self.emit(SegmentKind::FunctionDefinition, vec![name], vec![], vec![], None);
                let own = definition.body.1.as_ref().map(|list| self.redirects(&list.0)).unwrap_or_default();
                self.inherited.push(own);
                self.within(Context::FunctionBody, |walker| walker.compound(&definition.body.0));
                self.inherited.pop();
            }
            Command::ExtendedTest(test, redirects) => {
                let own = redirects.as_ref().map(|list| self.redirects(&list.0)).unwrap_or_default();
                self.test_words(&test.expr);
                self.emit(SegmentKind::Test, vec![], vec![], own, None);
            }
        }
    }

    fn test_words(&mut self, expr: &ExtendedTestExpr) {
        match expr {
            ExtendedTestExpr::And(left, right) | ExtendedTestExpr::Or(left, right) => {
                self.test_words(left);
                self.test_words(right);
            }
            ExtendedTestExpr::Not(inner) | ExtendedTestExpr::Parenthesized(inner) => self.test_words(inner),
            ExtendedTestExpr::UnaryTest(_, word) => {
                self.word(word);
            }
            ExtendedTestExpr::BinaryTest(_, left, right) => {
                self.word(left);
                self.word(right);
            }
        }
    }

    fn compound(&mut self, compound: &CompoundCommand) {
        match compound {
            CompoundCommand::Arithmetic(arithmetic) => {
                self.expanded_text(&arithmetic.expr.value);
                self.emit(SegmentKind::Arithmetic, vec![], vec![], vec![], None);
            }
            CompoundCommand::ArithmeticForClause(clause) => {
                for expr in [&clause.initializer, &clause.condition, &clause.updater].into_iter().flatten() {
                    self.expanded_text(&expr.value);
                }
                self.compound_list(&clause.body.list);
            }
            CompoundCommand::BraceGroup(group) => self.compound_list(&group.list),
            CompoundCommand::Subshell(subshell) => self.within(Context::Subshell, |walker| walker.compound_list(&subshell.list)),
            CompoundCommand::ForClause(clause) => {
                // The loop's variable takes each value in turn: an assignment for each, so that a later
                // use sees every value it may have. Without a list it takes the positional parameters.
                let assigned: Vec<Assigned> = match &clause.values {
                    Some(values) => values.iter().map(|value| Assigned { name: clause.variable_name.clone(), value: Some(self.word(value)), append: false }).collect(),
                    None => vec![Assigned { name: clause.variable_name.clone(), value: None, append: false }],
                };
                self.emit(SegmentKind::Simple, vec![], assigned, vec![], None);
                self.compound_list(&clause.body.list);
            }
            CompoundCommand::WhileClause(clause) | CompoundCommand::UntilClause(clause) => {
                self.compound_list(&clause.0);
                self.compound_list(&clause.1.list);
            }
            CompoundCommand::IfClause(clause) => {
                self.compound_list(&clause.condition);
                self.compound_list(&clause.then);
                for branch in clause.elses.iter().flatten() {
                    if let Some(condition) = &branch.condition {
                        self.compound_list(condition);
                    }
                    self.compound_list(&branch.body);
                }
            }
            CompoundCommand::CaseClause(clause) => {
                self.word(&clause.value);
                for item in &clause.cases {
                    for pattern in &item.patterns {
                        self.word(pattern);
                    }
                    if let Some(body) = &item.cmd {
                        self.compound_list(body);
                    }
                }
            }
            CompoundCommand::Coprocess(coprocess) => self.command(&coprocess.body),
        }
    }

    fn simple(&mut self, simple: &SimpleCommand) {
        // Taken first, so that a substitution in its words does not take its place.
        let pipe = self.pending_pipe.take();
        let mut words = Vec::new();
        let mut assignments = Vec::new();
        let mut redirects = Vec::new();
        for item in simple.prefix.iter().flat_map(|prefix| prefix.0.iter()) {
            if let CommandPrefixOrSuffixItem::Word(word) = item {
                self.fail(format!("A word before the command's name is not followed: {}", word.value));
            }
            self.item(item, true, &mut words, &mut assignments, &mut redirects);
        }
        if let Some(name) = &simple.word_or_name {
            let name = self.word(name);
            words.insert(0, name);
        }
        for item in simple.suffix.iter().flat_map(|suffix| suffix.0.iter()) {
            self.item(item, false, &mut words, &mut assignments, &mut redirects);
        }
        self.emit(SegmentKind::Simple, words, assignments, redirects, pipe);
    }

    /// Adds a simple command's `item` to its words, assignments or redirects. An assignment before the
    /// command's name sets a variable for it; one after the name is an argument (`env X=1`, `make A=b`).
    fn item(&mut self, item: &CommandPrefixOrSuffixItem, before_name: bool, words: &mut Vec<WordOut>, assignments: &mut Vec<Assigned>, redirects: &mut Vec<Redirect>) {
        match item {
            CommandPrefixOrSuffixItem::Word(word) => {
                let word = self.word(word);
                words.push(word);
            }
            CommandPrefixOrSuffixItem::AssignmentWord(assignment, written) => {
                if before_name {
                    let value = self.assignment_value(&assignment.value);
                    let name = match &assignment.name {
                        ast::AssignmentName::VariableName(name) => name.clone(),
                        ast::AssignmentName::ArrayElementName(name, _) => name.clone(),
                    };
                    let scalar = matches!(assignment.name, ast::AssignmentName::VariableName(_));
                    assignments.push(Assigned { name, value: if scalar { value } else { None }, append: assignment.append });
                } else {
                    let word = self.word(written);
                    words.push(word);
                }
            }
            CommandPrefixOrSuffixItem::IoRedirect(redirect) => {
                let own = self.redirects(std::slice::from_ref(redirect));
                redirects.extend(own);
            }
            CommandPrefixOrSuffixItem::ProcessSubstitution(_, subshell) => {
                // A process substitution's result is a path, passed as an argument.
                words.push(WordOut { text: "<(…)".to_owned(), literal: None, parts: Vec::new() });
                self.within(Context::ProcessSubstitution, |walker| walker.compound_list(&subshell.list));
            }
        }
    }

    /// Walks an assignment's value; returns it as a word when it is a scalar, none for an array.
    fn assignment_value(&mut self, value: &AssignmentValue) -> Option<WordOut> {
        match value {
            AssignmentValue::Scalar(word) => Some(self.word(word)),
            AssignmentValue::Array(values) => {
                for (key, word) in values {
                    if let Some(key) = key {
                        self.word(key);
                    }
                    self.word(word);
                }
                None
            }
        }
    }

    fn redirects(&mut self, redirects: &[IoRedirect]) -> Vec<Redirect> {
        redirects
            .iter()
            .map(|redirect| match redirect {
                IoRedirect::File(fd, kind, target) => {
                    let op = match kind {
                        IoFileRedirectKind::Read => "<",
                        IoFileRedirectKind::Write => ">",
                        IoFileRedirectKind::Append => ">>",
                        IoFileRedirectKind::ReadAndWrite => "<>",
                        IoFileRedirectKind::Clobber => ">|",
                        IoFileRedirectKind::DuplicateInput => "<&",
                        IoFileRedirectKind::DuplicateOutput => ">&",
                    };
                    let target = match target {
                        IoFileRedirectTarget::Filename(word) | IoFileRedirectTarget::Duplicate(word) => Some(self.word(word)),
                        IoFileRedirectTarget::Fd(fd) => Some(WordOut { text: fd.to_string(), literal: Some(fd.to_string()), parts: Vec::new() }),
                        IoFileRedirectTarget::ProcessSubstitution(_, subshell) => {
                            self.within(Context::ProcessSubstitution, |walker| walker.compound_list(&subshell.list));
                            None
                        }
                    };
                    Redirect { op: op.to_owned(), fd: fd.as_ref().map(|fd| *fd as i32), target, body: None, expands: false }
                }
                IoRedirect::HereDocument(fd, document) => {
                    if document.requires_expansion {
                        self.expanded_text(&document.doc.value);
                    }
                    let body = if document.remove_tabs {
                        document.doc.value.split_inclusive('\n').map(|line| line.trim_start_matches('\t')).collect()
                    } else {
                        document.doc.value.clone()
                    };
                    Redirect { op: "<<".to_owned(), fd: fd.as_ref().map(|fd| *fd as i32), target: None, body: Some(body), expands: document.requires_expansion }
                }
                IoRedirect::HereString(fd, word) => {
                    let text = self.word(word);
                    let expands = text.literal.is_none();
                    Redirect { op: "<<<".to_owned(), fd: fd.as_ref().map(|fd| *fd as i32), target: None, body: Some(text.literal.unwrap_or(text.text)), expands }
                }
                IoRedirect::OutputAndError(word, append) => {
                    Redirect { op: if *append { "&>>" } else { "&>" }.to_owned(), fd: None, target: Some(self.word(word)), body: None, expands: false }
                }
            })
            .collect()
    }

    /// Walks text that is expanded as a double-quoted string is (a here-document's body, an
    /// arithmetic expression): the command substitutions in it are segments.
    fn expanded_text(&mut self, text: &str) {
        if !text.contains("$(") && !text.contains('`') {
            return;
        }
        let quoted = format!("\"{}\"", text.replace('"', "\\\""));
        match word::parse(&quoted, &parser_options()) {
            Ok(pieces) => {
                for piece in &pieces {
                    self.piece(piece, &quoted);
                }
            }
            Err(error) => self.fail(format!("Text with a command substitution does not parse: {error}")),
        }
    }

    /// Returns `word` as written and its literal value, walking the command substitutions in it.
    fn word(&mut self, word: &ast::Word) -> WordOut {
        let text = word.value.clone();
        match word::parse(&text, &parser_options()) {
            Ok(pieces) => {
                for piece in &pieces {
                    self.piece(piece, &text);
                }
                let literal = literal_of(&pieces);
                let parts = if literal.is_some() { Vec::new() } else { parts_of(&pieces, false) };
                WordOut { literal, text, parts }
            }
            Err(error) => {
                self.fail(format!("A word does not parse: {text}: {error}"));
                WordOut { text, literal: None, parts: Vec::new() }
            }
        }
    }

    fn piece(&mut self, piece: &WordPieceWithSource, source: &str) {
        match &piece.piece {
            WordPiece::DoubleQuotedSequence(inner) | WordPiece::GettextDoubleQuotedSequence(inner) => {
                for each in inner {
                    self.piece(each, source);
                }
            }
            WordPiece::CommandSubstitution(command) | WordPiece::BackquotedCommandSubstitution(command) => match parse(command) {
                Ok(program) => self.within(Context::CommandSubstitution, |walker| walker.program(&program)),
                Err(reason) => self.fail(format!("A command substitution does not parse: {reason}")),
            },
            WordPiece::ParameterExpansion(_) => {
                let written = source.get(piece.start_index..piece.end_index).unwrap_or(source);
                if written.contains("$(") || written.contains('`') {
                    self.fail(format!("A command substitution inside a parameter expansion is not followed: {written}"));
                }
            }
            WordPiece::ArithmeticExpression(expr) => self.expanded_text(&expr.value),
            WordPiece::Text(_) | WordPiece::SingleQuotedText(_) | WordPiece::AnsiCQuotedText(_) | WordPiece::EscapeSequence(_) | WordPiece::TildeExpansion(_) => {}
        }
    }
}

/// Returns the value of a word made of `pieces` when it is a literal string, else `None`.
fn literal_of(pieces: &[WordPieceWithSource]) -> Option<String> {
    let mut value = String::new();
    for piece in pieces {
        match &piece.piece {
            WordPiece::Text(text) => {
                if text.chars().any(|character| matches!(character, '*' | '?' | '[')) || braces_expand(text) {
                    return None;
                }
                value.push_str(text);
            }
            WordPiece::SingleQuotedText(text) => value.push_str(text),
            WordPiece::EscapeSequence(escaped) => value.push_str(escaped.strip_prefix('\\').unwrap_or(escaped)),
            WordPiece::DoubleQuotedSequence(inner) => {
                for each in inner {
                    match &each.piece {
                        WordPiece::Text(text) => value.push_str(text),
                        WordPiece::EscapeSequence(escaped) => value.push_str(escaped.strip_prefix('\\').unwrap_or(escaped)),
                        _ => return None,
                    }
                }
            }
            _ => return None,
        }
    }
    Some(value)
}

/// The parts of a word's `pieces`, in order; `quoted` when they are inside double quotes. Adjacent
/// text with the same quoting is one part.
fn parts_of(pieces: &[WordPieceWithSource], quoted: bool) -> Vec<Part> {
    let mut parts: Vec<Part> = Vec::new();
    for piece in pieces {
        let next: Vec<Part> = match &piece.piece {
            WordPiece::Text(text) => vec![Part::Text { value: text.clone(), quoted }],
            WordPiece::SingleQuotedText(text) => vec![Part::Text { value: text.clone(), quoted: true }],
            WordPiece::AnsiCQuotedText(text) => vec![Part::Text { value: text.clone(), quoted: true }],
            WordPiece::EscapeSequence(escaped) => vec![Part::Text { value: escaped.strip_prefix('\\').unwrap_or(escaped).to_owned(), quoted: true }],
            WordPiece::DoubleQuotedSequence(inner) | WordPiece::GettextDoubleQuotedSequence(inner) => parts_of(inner, true),
            WordPiece::TildeExpansion(expr) => vec![tilde_of(expr)],
            WordPiece::ParameterExpansion(expr) => vec![parameter_of(expr, quoted)],
            WordPiece::CommandSubstitution(command) | WordPiece::BackquotedCommandSubstitution(command) => vec![Part::Command { command: command.clone(), quoted }],
            WordPiece::ArithmeticExpression(expr) => vec![Part::Arithmetic { expression: expr.value.clone(), quoted }],
        };
        for part in next {
            match (parts.last_mut(), &part) {
                (Some(Part::Text { value, quoted: before }), Part::Text { value: more, quoted: now }) if before == now => value.push_str(more),
                _ => parts.push(part),
            }
        }
    }
    parts
}

fn tilde_of(expr: &TildeExpr) -> Part {
    match expr {
        TildeExpr::Home => Part::Tilde { of: TildeOf::Home, user: None },
        TildeExpr::UserHome(user) => Part::Tilde { of: TildeOf::User, user: Some(user.clone()) },
        TildeExpr::WorkingDir => Part::Tilde { of: TildeOf::Working, user: None },
        TildeExpr::OldWorkingDir => Part::Tilde { of: TildeOf::Previous, user: None },
        TildeExpr::NthDirFromTopOfDirStack { .. } | TildeExpr::NthDirFromBottomOfDirStack { .. } => Part::Tilde { of: TildeOf::Stack, user: None },
    }
}

/// A parameter's name as the shell writes it: `HOME`, `1`, `@`, `?`; with an index or as an array, `other`.
fn parameter_name(parameter: &Parameter) -> Option<String> {
    match parameter {
        Parameter::Positional(n) => Some(n.to_string()),
        Parameter::Named(name) => Some(name.clone()),
        Parameter::Special(special) => Some(
            match special {
                SpecialParameter::AllPositionalParameters { concatenate: true } => "*",
                SpecialParameter::AllPositionalParameters { concatenate: false } => "@",
                SpecialParameter::PositionalParameterCount => "#",
                SpecialParameter::LastExitStatus => "?",
                SpecialParameter::CurrentOptionFlags => "-",
                SpecialParameter::ProcessId => "$",
                SpecialParameter::LastBackgroundProcessId => "!",
                SpecialParameter::ShellName => "0",
            }
            .to_owned(),
        ),
        Parameter::NamedWithIndex { .. } | Parameter::NamedWithAllIndices { .. } => None,
    }
}

/// The parts of an operation's `word` (a default, an alternative), parsed as a word is.
fn word_parts(word: &Option<String>, quoted: bool) -> Option<Vec<Part>> {
    let text = word.as_deref().unwrap_or("");
    word::parse(text, &parser_options()).ok().map(|pieces| parts_of(&pieces, quoted))
}

fn parameter_of(expr: &ParameterExpr, quoted: bool) -> Part {
    let other = |parameter: &Parameter| Part::Parameter { name: parameter_name(parameter).unwrap_or_default(), op: ParameterOp::Other, word: None, pattern: None, quoted };
    let made = |parameter: &Parameter, indirect: bool, op: ParameterOp, word: Option<Vec<Part>>, pattern: Option<String>| match parameter_name(parameter) {
        Some(name) if !indirect => Part::Parameter { name, op, word, pattern, quoted },
        _ => other(parameter),
    };
    let tested = |test: &ParameterTestType, unset_or_null: ParameterOp, unset: ParameterOp| match test {
        ParameterTestType::UnsetOrNull => unset_or_null,
        ParameterTestType::Unset => unset,
    };
    match expr {
        ParameterExpr::Parameter { parameter, indirect } => made(parameter, *indirect, ParameterOp::Value, None, None),
        ParameterExpr::UseDefaultValues { parameter, indirect, test_type, default_value } => {
            made(parameter, *indirect, tested(test_type, ParameterOp::Default, ParameterOp::DefaultIfUnset), word_parts(default_value, quoted), None)
        }
        ParameterExpr::AssignDefaultValues { parameter, indirect, test_type, default_value } => {
            made(parameter, *indirect, tested(test_type, ParameterOp::Assign, ParameterOp::AssignIfUnset), word_parts(default_value, quoted), None)
        }
        ParameterExpr::UseAlternativeValue { parameter, indirect, test_type, alternative_value } => {
            made(parameter, *indirect, tested(test_type, ParameterOp::Alternative, ParameterOp::AlternativeIfUnset), word_parts(alternative_value, quoted), None)
        }
        ParameterExpr::IndicateErrorIfNullOrUnset { parameter, indirect, .. } => made(parameter, *indirect, ParameterOp::Error, None, None),
        ParameterExpr::ParameterLength { parameter, indirect } => made(parameter, *indirect, ParameterOp::Length, None, None),
        ParameterExpr::RemoveSmallestSuffixPattern { parameter, indirect, pattern } => made(parameter, *indirect, ParameterOp::RemoveSuffix, None, pattern.clone()),
        ParameterExpr::RemoveLargestSuffixPattern { parameter, indirect, pattern } => made(parameter, *indirect, ParameterOp::RemoveLongestSuffix, None, pattern.clone()),
        ParameterExpr::RemoveSmallestPrefixPattern { parameter, indirect, pattern } => made(parameter, *indirect, ParameterOp::RemovePrefix, None, pattern.clone()),
        ParameterExpr::RemoveLargestPrefixPattern { parameter, indirect, pattern } => made(parameter, *indirect, ParameterOp::RemoveLongestPrefix, None, pattern.clone()),
        ParameterExpr::Substring { parameter, .. }
        | ParameterExpr::Transform { parameter, .. }
        | ParameterExpr::UppercaseFirstChar { parameter, .. }
        | ParameterExpr::UppercasePattern { parameter, .. }
        | ParameterExpr::LowercaseFirstChar { parameter, .. }
        | ParameterExpr::LowercasePattern { parameter, .. }
        | ParameterExpr::ReplaceSubstring { parameter, .. } => other(parameter),
        _ => Part::Parameter { name: String::new(), op: ParameterOp::Other, word: None, pattern: None, quoted },
    }
}

/// Whether unquoted `text` has a brace expansion: `{` with a `,` or `..` before its `}`. A lone `{`, `}`
/// or `{}` is literal.
fn braces_expand(text: &str) -> bool {
    text.match_indices('{').any(|(open, _)| {
        let rest = &text[open + 1..];
        rest.find('}').is_some_and(|close| rest[..close].contains(',') || rest[..close].contains(".."))
    })
}

/// Allocates `len` bytes in this module's memory, for the caller to write a command into.
#[unsafe(no_mangle)]
pub extern "C" fn segments_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Frees `len` bytes at `pointer`, allocated by `segments_alloc` or returned by `segments_json`.
///
/// # Safety
/// `pointer` and `len` must be a buffer this module allocated, not freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn segments_free(pointer: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(pointer, 0, len) });
}

/// Reads the UTF-8 command of `len` bytes at `pointer`, and returns its segments as JSON, in a buffer
/// of this module's memory: its address in the high 32 bits and its length in the low 32 bits. The
/// caller frees it with `segments_free`. A command that is not UTF-8 is `Unparsed`.
///
/// # Safety
/// `pointer` and `len` must be a buffer of this module's memory holding the command.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn segments_json(pointer: *const u8, len: usize) -> u64 {
    let bytes = unsafe { std::slice::from_raw_parts(pointer, len) };
    let result = match std::str::from_utf8(bytes) {
        Ok(command) => segments_of(command),
        Err(error) => Segments::Unparsed { reason: format!("The command is not UTF-8: {error}") },
    };
    let json = serde_json::to_vec(&result).unwrap_or_else(|_| br#"{"_tag":"Unparsed","reason":"The segments could not be written as JSON."}"#.to_vec());
    let mut boxed = json.into_boxed_slice();
    let out_len = boxed.len();
    let out = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    ((out as u64) << 32) | out_len as u64
}
