#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *result = [NSMutableArray array];
        for (int index = 1; index < argc; index++) {
            NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[index]]];
            VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:url options:@{}];
            VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
            request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
            request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
            request.usesLanguageCorrection = YES;
            NSError *error = nil;
            if (![handler performRequests:@[request] error:&error]) {
                fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
                return 1;
            }

            NSMutableArray<NSString *> *lines = [NSMutableArray array];
            for (VNRecognizedTextObservation *observation in request.results) {
                VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
                if (candidate.confidence >= 0.55) [lines addObject:candidate.string];
            }
            [result addObject:[lines componentsJoinedByString:@"\n"]];
        }

        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
        if (!data) return 1;
        fwrite(data.bytes, 1, data.length, stdout);
        return 0;
    }
}
