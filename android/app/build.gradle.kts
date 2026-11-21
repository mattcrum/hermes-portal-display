plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.mattcrum.hermesdisplay"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.mattcrum.hermesdisplay"
        minSdk = 28          // Portal 1st gen = Android 9
        targetSdk = 34
        versionCode = 9
        versionName = "0.4.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // sideload-only
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Offline speech recognizer used only as a wake-phrase spotter ("hey hermes").
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
}
