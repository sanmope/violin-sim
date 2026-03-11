package com.violinsim.android.websocket

import android.util.Log
import com.violinsim.android.audio.ProcessedFrame
import com.violinsim.android.config.AudioConfig
import okhttp3.*
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PipelineClient(
    private val serverUrl: String,
    private val sessionId: String,
    private val clientId: String
) {
    companion object {
        const val TAG = "PipelineClient"
        const val QUEUE_CAPACITY = 20
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val queue = LinkedBlockingQueue<ProcessedFrame>(QUEUE_CAPACITY)
    private var ws: WebSocket? = null
    private var senderThread: Thread? = null
    @Volatile private var isConnected = false
    @Volatile private var isRunning = false

    fun enqueue(frame: ProcessedFrame) {
        if (!queue.offer(frame)) {
            queue.poll()
            queue.offer(frame)
        }
    }

    fun connect() {
        isRunning = true
        connectWebSocket()
        senderThread = Thread({ sendLoop() }, "pipeline-sender").also { it.start() }
    }

    fun close() {
        isRunning = false
        senderThread?.interrupt()
        ws?.close(1000, "closing")
        client.dispatcher.executorService.shutdown()
    }

    private fun connectWebSocket() {
        val url = "$serverUrl?session_id=$sessionId&client_id=$clientId"
        val request = Request.Builder().url(url).build()

        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "Connected to server: $url")
                isConnected = true
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Connection failed: ${t.message} — reconnecting in 2s")
                isConnected = false
                if (isRunning) {
                    Thread.sleep(2000)
                    connectWebSocket()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "Disconnected: $reason")
                isConnected = false
                if (isRunning) {
                    Thread.sleep(2000)
                    connectWebSocket()
                }
            }
        })
    }

    private fun sendLoop() {
        while (isRunning) {
            try {
                val frame = queue.poll(1, TimeUnit.SECONDS) ?: continue
                if (!isConnected) continue

                val json = buildServerPayload(frame)
                ws?.send(json)
            } catch (_: InterruptedException) {
                break
            }
        }
    }

    private fun buildServerPayload(frame: ProcessedFrame): String {
        val sb = StringBuilder(frame.rawChunk.size * 10)
        sb.append("{\"session_id\":\"").append(sessionId)
        sb.append("\",\"ts\":").append(frame.ts)
        sb.append(",\"pitch\":").append("%.2f".format(frame.pitch))
        sb.append(",\"sr\":").append(AudioConfig.SAMPLE_RATE)
        sb.append(",\"chunk\":[")
        frame.rawChunk.forEachIndexed { i, v ->
            if (i > 0) sb.append(',')
            sb.append("%.6f".format(v))
        }
        sb.append("]}")
        return sb.toString()
    }
}
