package com.violinsim.android.config

object AudioConfig {
    const val SAMPLE_RATE = 44100
    const val BUFFER_SIZE = 2205                // SAMPLE_RATE / 20 = 50ms
    const val RMS_THRESHOLD = 0.015f
    const val CONFIDENCE_THRESHOLD = 0.7f
    const val N_MEL_BINS = 64
    const val N_FFT_BINS = 256
    const val FMIN = 49.0
    const val FMAX = 2637.0
    const val LOCAL_WINDOW = 4410              // SAMPLE_RATE / 10 = 100ms ring buffer
    const val MEL_NPERSEG = 512
    const val MEL_NOVERLAP = 256
    const val LOCAL_WS_PORT = 8001
    const val DEFAULT_SERVER_URL = "ws://10.0.2.2:8000/audio"
    const val DEFAULT_SESSION_ID = "session-default"
}
