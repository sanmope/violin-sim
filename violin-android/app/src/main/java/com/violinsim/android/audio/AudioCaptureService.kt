package com.violinsim.android.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import com.violinsim.android.R
import com.violinsim.android.config.AudioConfig
import com.violinsim.android.websocket.LocalBroadcastServer
import com.violinsim.android.websocket.PipelineClient

class AudioCaptureService : Service() {

    companion object {
        const val TAG = "AudioCapture"
        const val CHANNEL_ID = "audio_capture"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_SESSION_ID = "session_id"
    }

    private var captureThread: Thread? = null
    private var isRunning = false
    private var localServer: LocalBroadcastServer? = null
    private var pipelineClient: PipelineClient? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val serverUrl = intent?.getStringExtra(EXTRA_SERVER_URL) ?: AudioConfig.DEFAULT_SERVER_URL
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID) ?: AudioConfig.DEFAULT_SESSION_ID
        val clientId = "$sessionId-android"

        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()

        startForeground(1, notification)

        // Start local WebSocket server (for React WebView)
        localServer = LocalBroadcastServer(AudioConfig.LOCAL_WS_PORT).also { it.start() }
        Log.i(TAG, "Local WS server started on :${AudioConfig.LOCAL_WS_PORT}")

        // Start pipeline client (to send audio to server)
        pipelineClient = PipelineClient(serverUrl, sessionId, clientId).also { it.connect() }
        Log.i(TAG, "Pipeline client connecting to $serverUrl")

        // Start audio capture thread
        isRunning = true
        captureThread = Thread({ captureLoop() }, "audio-capture").also {
            it.priority = Thread.MAX_PRIORITY
            it.start()
        }

        return START_STICKY
    }

    private fun captureLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)

        val minBuf = AudioRecord.getMinBufferSize(
            AudioConfig.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        )
        val bufSize = maxOf(minBuf, AudioConfig.BUFFER_SIZE * 4 * 2)

        val recorder = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            AudioConfig.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
            bufSize
        )

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            return
        }

        val processor = AudioProcessor()
        val chunk = FloatArray(AudioConfig.BUFFER_SIZE)

        recorder.startRecording()
        Log.i(TAG, "Recording started — buffer=${AudioConfig.BUFFER_SIZE / AudioConfig.SAMPLE_RATE.toFloat() * 1000}ms")

        try {
            while (isRunning) {
                val read = recorder.read(chunk, 0, chunk.size, AudioRecord.READ_BLOCKING)
                if (read != chunk.size) continue

                val frame = processor.process(chunk) ?: continue

                // Broadcast to local WebSocket (React WebView)
                localServer?.broadcast(frame)

                // Send to pipeline server
                pipelineClient?.enqueue(frame)
            }
        } finally {
            recorder.stop()
            recorder.release()
            Log.i(TAG, "Recording stopped")
        }
    }

    override fun onDestroy() {
        isRunning = false
        captureThread?.interrupt()
        localServer?.stop()
        pipelineClient?.close()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
