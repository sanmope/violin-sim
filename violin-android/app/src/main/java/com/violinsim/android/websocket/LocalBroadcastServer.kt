package com.violinsim.android.websocket

import android.util.Log
import com.violinsim.android.audio.ProcessedFrame
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress

class LocalBroadcastServer(port: Int) : WebSocketServer(InetSocketAddress(port)) {

    companion object {
        const val TAG = "LocalWS"
    }

    fun broadcast(frame: ProcessedFrame) {
        val json = buildJsonPayload(frame)
        val dead = mutableSetOf<WebSocket>()
        for (conn in connections) {
            try {
                conn.send(json)
            } catch (_: Exception) {
                dead.add(conn)
            }
        }
        for (conn in dead) {
            try { conn.close() } catch (_: Exception) {}
        }
    }

    private fun buildJsonPayload(frame: ProcessedFrame): String {
        // Use StringBuilder for performance — avoids JSONArray boxing each float
        val sb = StringBuilder(8192)
        sb.append("{\"type\":\"pitch\",\"ts\":")
        sb.append(frame.ts)
        sb.append(",\"pitch\":")
        sb.append("%.2f".format(frame.pitch))
        sb.append(",\"mel\":[")
        frame.mel.forEachIndexed { i, v ->
            if (i > 0) sb.append(',')
            sb.append("%.6f".format(v))
        }
        sb.append("],\"fft\":[")
        frame.fft.forEachIndexed { i, v ->
            if (i > 0) sb.append(',')
            sb.append("%.6f".format(v))
        }
        sb.append("]}")
        return sb.toString()
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        Log.i(TAG, "Client connected: ${conn.remoteSocketAddress}")
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        Log.i(TAG, "Client disconnected: ${conn.remoteSocketAddress}")
    }

    override fun onMessage(conn: WebSocket, message: String) {
        // Ignore incoming messages from WebView
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        Log.e(TAG, "WebSocket error: ${ex.message}")
    }

    override fun onStart() {
        Log.i(TAG, "Local broadcast server started")
    }
}
