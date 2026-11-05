# JNA looks up native methods and the Sodium interface by reflection
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep interface app.cipherfilm.cfnative.Sodium { *; }
-dontwarn java.awt.**

# WorkManager (the background backup) creates its Room database by reflection: keep the generated constructors
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# ONNX Runtime binds its Java classes from native code (search, Vision.kt)
-keep class ai.onnxruntime.** { *; }
