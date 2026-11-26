import Foundation

/// `wizards-mlx`: a model of Apple's MLX on this Mac, as a long-lived child process. Requests come
/// in on stdin and answers go out on stdout, one JSON object per line. It ends with its stdin.

import MLX

// What MLX keeps aside of freed memory, so that the next call does not ask the system for it.
Memory.cacheLimit = 512 * 1024 * 1024

var running: [String: Task<Void, Never>] = [:]
let decoder = JSONDecoder()

for try await line in FileHandle.standardInput.bytes.lines {
    guard let request = try? decoder.decode(Request.self, from: Data(line.utf8)) else {
        await Out.shared.send(Chunk(id: "", error: "not a request"))
        continue
    }
    if request.unload == true {
        await Engine.shared.unload()
        continue
    }
    guard let id = request.id else { continue }
    if request.cancel == true {
        running.removeValue(forKey: id)?.cancel()
        continue
    }
    guard let chat = request.chat else { continue }
    running[id] = Task {
        do {
            try await Engine.shared.chat(id, chat)
        } catch is CancellationError {
            await Out.shared.send(Chunk(id: id, done: true, done_reason: "cancel"))
        } catch {
            await Out.shared.send(Chunk(id: id, error: "\(error)"))
        }
    }
}
