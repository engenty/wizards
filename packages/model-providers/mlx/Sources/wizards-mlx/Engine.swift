import CoreImage
import Foundation
import MLX
import MLXGuidedGeneration
import MLXLLM
import MLXLMCommon
import MLXVLM

/// The one model in memory. Another one takes its place. Its calls answer one after the other.
actor Engine {
    static let shared = Engine()
    private var held: Held?
    /// The call that answers now; the next one waits for it.
    private var last: Task<Void, Never>?

    final class Held: @unchecked Sendable {
        let dir: String
        let container: ModelContainer
        /// Prompts the model has read already; the newest is last.
        var read: [Read] = []
        var bias: (closing: MLXArray, whitespace: MLXArray, ids: Set<Int>)?
        var grammar: GrammarTokenizer?
        init(dir: String, container: ModelContainer) {
            self.dir = dir
            self.container = container
        }
    }

    /// The start of a prompt and what the model keeps of it.
    final class Read: @unchecked Sendable {
        let tokens: [Int]
        let cache: [KVCache]
        init(tokens: [Int], cache: [KVCache]) {
            self.tokens = tokens
            self.cache = cache
        }
    }

    /// How many prompts stay read: the conversation and what runs beside it.
    static let kept = 2
    /// How many tokens are read at a time: after each, the caller hears how far it is, and a call
    /// given up ends.
    static let piece = 512

    private func model(_ dir: String) async throws -> Held {
        if let held, held.dir == dir { return held }
        unload()
        let container = try await loadModelContainer(
            from: URL(fileURLWithPath: dir), using: HubTokenizerLoader())
        let model = Held(dir: dir, container: container)
        held = model
        return model
    }

    func unload() {
        held = nil
        Memory.clearCache()
    }

    /// Runs a call once the ones before it are over.
    func chat(_ id: String, _ request: ChatRequest) async throws {
        let before = last
        let call = Task { [self] in
            await before?.value
            try Task.checkCancellation()
            try await answer(id, request)
        }
        last = Task { _ = try? await call.value }
        try await withTaskCancellationHandler {
            try await call.value
        } onCancel: {
            call.cancel()
        }
    }

    private func answer(_ id: String, _ request: ChatRequest) async throws {
        if held?.dir != request.model {
            await Out.shared.send(Chunk(id: id, wait: .init(state: "loading")))
        }
        let held = try await model(request.model)
        try Task.checkCancellation()
        let chat = Box(try request.messages.map(Self.message))
        let tools = request.tools?.compactMap { $0.object?.mapValues { $0.sendable } }
        let options = request.options
        let context: [String: any Sendable]? = request.think.map { ["enable_thinking": $0] }
        let parameters = GenerateParameters(
            maxTokens: options?.num_predict,
            temperature: options?.temperature ?? 0.6,
            topP: options?.top_p ?? 1,
            topK: options?.top_k ?? 0,
            seed: options?.seed)
        let started = Date()
        if request.warm == true {
            try await warm(id, held, chat, tools, context, parameters)
            return
        }
        if let schema = request.schema {
            await Out.shared.send(Chunk(id: id, wait: .init(state: "reading")))
            let input = Box(
                try await held.container.prepare(
                    input: UserInput(chat: chat.value, tools: tools, additionalContext: context)))
            try await guided(id, held, input, schema, options, parameters)
            return
        }
        let pictures = chat.value.contains { !$0.images.isEmpty }
        let (stream, count, known) = try await held.container.perform { model in
            let input = try await model.processor.prepare(
                input: UserInput(chat: chat.value, tools: tools, additionalContext: context))
            if pictures {
                let count = input.text.tokens.size
                let stream = try MLXLMCommon.generate(
                    input: input, parameters: parameters, context: model, tools: tools)
                return (stream, count, 0)
            }
            let tokens = input.text.tokens.asArray(Int.self)
            // What the same conversation starts with once it has gone on: the template writes the
            // end of a prompt differently when an answer follows it.
            let next = try await model.processor.prepare(
                input: UserInput(
                    chat: chat.value + [.assistant("x")], tools: tools, additionalContext: context))
            let stable = min(
                Self.common(tokens, next.text.tokens.asArray(Int.self)), tokens.count - 1)
            let (cache, known) = try await held.cache(id, tokens, upTo: stable, model, parameters)
            let rest = MLXArray(tokens[stable...].map { Int32($0) })
            let stream = try MLXLMCommon.generate(
                input: LMInput(tokens: rest), cache: cache, parameters: parameters, context: model,
                tools: tools)
            return (stream, tokens.count, known)
        }
        let prefilled = Date()
        var first: Date?
        for await part in stream {
            try Task.checkCancellation()
            switch part {
            case .chunk(let text):
                first = first ?? Date()
                await Out.shared.send(Chunk(id: id, message: .init(content: text)))
            case .reasoning(let text):
                first = first ?? Date()
                await Out.shared.send(Chunk(id: id, message: .init(thinking: text)))
            case .toolCall(let call):
                let function = Chunk.Function(
                    name: call.function.name, arguments: call.function.arguments)
                await Out.shared.send(
                    Chunk(id: id, message: .init(tool_calls: [.init(function: function)])))
            case .rejectedToolCall(let call):
                // The host answers a call of a tool it did not offer; one that cannot be read is an
                // error, never an answer without a word.
                guard let function = Self.function(of: call) else {
                    throw Unreadable(reason: call.reason.rawValue)
                }
                first = first ?? Date()
                await Out.shared.send(
                    Chunk(id: id, message: .init(tool_calls: [.init(function: function)])))
            case .info(let info):
                await Out.shared.send(
                    Chunk(
                        id: id, done: true,
                        done_reason: info.stopReason == .length ? "length" : "stop",
                        prompt_eval_count: count, eval_count: info.generationTokenCount,
                        prompt_seconds: prefilled.timeIntervalSince(started) + info.promptTime,
                        eval_seconds: info.generateTime, cached: known,
                        memory: Memory.peakMemory))
            default:
                break
            }
        }
        // A call given up ends the stream without a word.
        try Task.checkCancellation()
    }

    /// Reads what a chat starts with whatever the person writes next. The last message stands for it.
    private func warm(
        _ id: String, _ held: Held, _ chat: Box<[Chat.Message]>, _ tools: [ToolSpec]?,
        _ context: [String: any Sendable]?, _ parameters: GenerateParameters
    ) async throws {
        let known = try await held.container.perform { model in
            let before = Array(chat.value.dropLast())
            var prompts: [[Int]] = []
            for text in ["a", "b"] {
                let input = try await model.processor.prepare(
                    input: UserInput(
                        chat: before + [.user(text)], tools: tools, additionalContext: context))
                prompts.append(input.text.tokens.asArray(Int.self))
            }
            let shared = Self.common(prompts[0], prompts[1])
            return try await held.cache(id, prompts[0], upTo: shared, model, parameters).1
        }
        await Out.shared.send(Chunk(id: id, done: true, done_reason: "stop", cached: known))
    }

    struct Unreadable: Error, CustomStringConvertible {
        let reason: String
        var description: String { "The model wrote a tool call that cannot be read (\(reason))." }
    }

    private struct Called: Decodable {
        var name: String
        var arguments: [String: JSONValue]?
        var parameters: [String: JSONValue]?
    }

    /// What a call the library did not pass on was meant to be.
    private static func function(of call: RejectedToolCall) -> Chunk.Function? {
        let text = call.rawTextPreview
        guard !call.isPreviewTruncated, let from = text.firstIndex(of: "{"),
            let to = text.lastIndex(of: "}"), from < to,
            let called = try? JSONDecoder().decode(Called.self, from: Data(text[from...to].utf8))
        else { return nil }
        return .init(name: called.name, arguments: called.arguments ?? called.parameters ?? [:])
    }

    /// How many tokens two prompts start with in common.
    static func common(_ a: [Int], _ b: [Int]) -> Int {
        var n = 0
        while n < a.count, n < b.count, a[n] == b[n] { n += 1 }
        return n
    }

    /// An answer that cannot but match the schema: every other token is masked.
    private func guided(
        _ id: String, _ held: Held, _ input: Box<LMInput>, _ schema: String,
        _ options: ChatRequest.Options?, _ parameters: GenerateParameters
    ) async throws {
        let started = Date()
        let max = options?.num_predict ?? 8192
        let sink = Sink(id: id)
        let count = try await held.container.perform { context in
            let tokenizer = context.tokenizer
            if held.grammar == nil {
                let vocab = TokenizerVocabExtractor.extractForGrammar(from: tokenizer)
                held.grammar = try GrammarTokenizer(
                    vocab: vocab.vocab, vocabType: vocab.vocabType,
                    eosTokenId: Int32(tokenizer.eosTokenId ?? 0))
                let whitespace = WhitespaceTokenBias.compute(tokenizer: tokenizer)
                held.bias = (
                    ClosingTokenBias.compute(
                        tokenizer: tokenizer, eosTokenId: tokenizer.eosTokenId),
                    whitespace.bias, whitespace.tokenIDs
                )
            }
            let grammar = held.grammar!
            let constraint = try GrammarConstraint(
                tokenizer: grammar, jsonSchema: schema, fastForward: true,
                hostTokenizer: tokenizer)
            return try GuidedGenerationLoop.run(
                input: input.value, context: context, constraint: constraint, maxTokens: max,
                vocabSize: grammar.vocabSize, closingBias: held.bias?.closing,
                whitespaceBias: held.bias?.whitespace,
                whitespaceTokenIDs: held.bias?.ids ?? [],
                logitSampler: parameters.sampler()
            ) { delta in
                sink.say(delta)
                return !Task.isCancelled
            }
        }
        try Task.checkCancellation()
        await sink.end()
        await Out.shared.send(
            Chunk(
                id: id, done: true, done_reason: "stop",
                prompt_eval_count: input.value.text.tokens.size, eval_count: count,
                eval_seconds: Date().timeIntervalSince(started), memory: Memory.peakMemory))
    }

    private static func message(_ m: ChatRequest.Message) throws -> Chat.Message {
        let text = m.content ?? ""
        switch m.role {
        case "system":
            return .system(text)
        case "assistant":
            let calls = m.tool_calls?.map {
                ToolCall(
                    function: .init(
                        name: $0.function.name, arguments: $0.function.arguments.object ?? [:]))
            }
            return .assistant(text, toolCalls: calls)
        case "tool":
            return .tool(text, name: m.tool_name)
        default:
            let images: [UserInput.Image] = (m.images ?? []).compactMap {
                Data(base64Encoded: $0).flatMap { CIImage(data: $0) }.map { .ciImage($0) }
            }
            return .user(text, images: images)
        }
    }
}

final class Box<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

extension Engine.Held {
    /// A cache that holds the first `upTo` tokens of a prompt: from what the model has read
    /// already, the rest read now and kept, also of a call given up. Also how many it knew.
    func cache(
        _ id: String, _ tokens: [Int], upTo: Int, _ context: ModelContext,
        _ parameters: GenerateParameters
    ) async throws -> ([KVCache], Int) {
        var known = 0
        var cache: [KVCache]?
        for entry in read {
            let shared = Engine.common(Array(tokens[..<upTo]), entry.tokens)
            let whole = shared == entry.tokens.count
            let extra = entry.tokens.count - shared
            guard shared > known, whole || canTrimPromptCache(entry.cache, numTokens: extra)
            else { continue }
            let copy = entry.cache.map { $0.copy() }
            if !whole { trimPromptCache(copy, numTokens: extra) }
            cache = copy
            known = shared
        }
        let filled = try cache ?? context.model.newCache(parameters: parameters)
        var at = known
        defer { if at > known { keep(Array(tokens[..<at]), filled) } }
        var state: LMOutput.State?
        while at < upTo {
            await Out.shared.send(
                Chunk(
                    id: id,
                    wait: .init(state: "reading", done: at - known, total: tokens.count - known)))
            try Task.checkCancellation()
            let end = min(at + Engine.piece, upTo)
            let part = LMInput.Text(tokens: MLXArray(tokens[at..<end].map { Int32($0) }))
            state = context.model(part[text: .newAxis], cache: filled, state: state).state
            eval(filled.flatMap { $0.state })
            at = end
        }
        return (filled, known)
    }

    /// Keeps a prompt that was read, in the place of those of the same conversation: each takes
    /// the memory of all its tokens.
    private func keep(_ tokens: [Int], _ cache: [KVCache]) {
        read.removeAll { entry in
            let shared = Engine.common(entry.tokens, tokens)
            let extra = entry.tokens.count - shared
            return extra == 0
                || (shared > extra * 4 && canTrimPromptCache(cache, numTokens: extra))
        }
        read.append(Engine.Read(tokens: tokens, cache: cache.map { $0.copy() }))
        if read.count > Engine.kept { read.removeFirst() }
    }
}

/// Pieces of an answer made where nothing can wait, sent in their order.
final class Sink: @unchecked Sendable {
    private let continuation: AsyncStream<String>.Continuation
    private let sending: Task<Void, Never>
    init(id: String) {
        let (stream, continuation) = AsyncStream<String>.makeStream()
        self.continuation = continuation
        sending = Task {
            for await text in stream {
                await Out.shared.send(Chunk(id: id, message: .init(content: text)))
            }
        }
    }
    func say(_ text: String) { continuation.yield(text) }
    func end() async {
        continuation.finish()
        await sending.value
    }
}
