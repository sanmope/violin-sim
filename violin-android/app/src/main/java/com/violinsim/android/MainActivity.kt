package com.violinsim.android

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.violinsim.android.audio.AudioCaptureService

class MainActivity : AppCompatActivity() {

    companion object {
        const val REQUEST_PERMISSIONS = 1
        const val PREFS_NAME = "violin_config"
        const val PREF_SERVER_IP = "server_ip"
        const val PREF_SESSION_ID = "session_id"
    }

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        setupWebView()
        requestPermissions()
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
        }
        webView.webViewClient = WebViewClient()
        webView.setBackgroundColor(0xFF080810.toInt())
    }

    private fun requestPermissions() {
        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val needed = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (needed.isEmpty()) {
            onPermissionsGranted()
        } else {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQUEST_PERMISSIONS)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS) {
            if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                onPermissionsGranted()
            } else {
                Toast.makeText(this, "Mic permission required", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun onPermissionsGranted() {
        showServerDialog()
    }

    private fun showServerDialog() {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val savedIp = prefs.getString(PREF_SERVER_IP, "") ?: ""
        val savedSession = prefs.getString(PREF_SESSION_ID, "mi-sesion-123") ?: "mi-sesion-123"

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 32, 48, 16)
        }

        val ipInput = EditText(this).apply {
            hint = "IP del servidor (ej: 192.168.1.50)"
            setText(savedIp)
            setSingleLine()
        }

        val sessionInput = EditText(this).apply {
            hint = "Session ID"
            setText(savedSession)
            setSingleLine()
        }

        layout.addView(ipInput)
        layout.addView(sessionInput)

        AlertDialog.Builder(this)
            .setTitle("Configurar servidor")
            .setMessage("IP del server (Kubernetes/Docker) y session ID")
            .setView(layout)
            .setCancelable(false)
            .setPositiveButton("Conectar") { _, _ ->
                val ip = ipInput.text.toString().trim()
                val sessionId = sessionInput.text.toString().trim().ifEmpty { "mi-sesion-123" }

                if (ip.isEmpty()) {
                    Toast.makeText(this, "Ingresá la IP del servidor", Toast.LENGTH_SHORT).show()
                    showServerDialog()
                    return@setPositiveButton
                }

                // Save for next time
                prefs.edit()
                    .putString(PREF_SERVER_IP, ip)
                    .putString(PREF_SESSION_ID, sessionId)
                    .apply()

                startSession(ip, sessionId)
            }
            .show()
    }

    private fun startSession(serverIp: String, sessionId: String) {
        // Load React UI — inject STDB host before loading
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // Override the STDB connection URL for SpacetimeDB
                view.evaluateJavascript("""
                    (function() {
                        if (!window.__VIOLIN_SERVER_IP) {
                            window.__VIOLIN_SERVER_IP = '$serverIp';
                        }
                    })();
                """.trimIndent(), null)
            }
        }
        webView.loadUrl("file:///android_asset/web/index.html")

        // Start audio capture service
        val intent = Intent(this, AudioCaptureService::class.java).apply {
            putExtra(AudioCaptureService.EXTRA_SERVER_URL, "ws://$serverIp:8000/audio")
            putExtra(AudioCaptureService.EXTRA_SESSION_ID, sessionId)
        }
        startForegroundService(intent)
    }

    override fun onDestroy() {
        stopService(Intent(this, AudioCaptureService::class.java))
        super.onDestroy()
    }
}
