allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Keep AndroidX versions compatible with AGP 8.7.3 / Gradle 8.9, matching the
// toolchain used by cyrene_music_reborn.
subprojects {
    configurations.all {
        resolutionStrategy {
            force("androidx.camera:camera-core:1.5.1")
            force("androidx.camera:camera-camera2:1.5.1")
            force("androidx.camera:camera-lifecycle:1.5.1")
            force("androidx.browser:browser:1.8.0")
            force("androidx.core:core:1.13.1")
            force("androidx.core:core-ktx:1.13.1")
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
