package com.topcoder.challenges.mm160;

import com.topcoder.scorer.models.ScorerConfig;
import java.io.FileInputStream;
import java.io.IOException;

public class BioSlimeTester {
    public static double runTester(String submissionPath, ScorerConfig config) throws IOException {
        java.io.File dir = new java.io.File(submissionPath);
        java.io.File[] files = dir.listFiles();
        if (files == null || files.length == 0) {
            throw new IOException("No files found in submission directory: " + submissionPath);
        }
        java.io.File submissionFile = files[0];
        System.out.println("[DEBUG] Using submission file: " + submissionFile.getAbsolutePath());
        try (FileInputStream in = new FileInputStream(submissionFile)) {
            // The scoring is mocked here, but here we call new MarathonController().run(args) or equivalent for a challange.
            return 10.0;
        }
    }
} 