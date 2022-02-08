export class FrontendStack extends cdk.Stack {
  private static execOptions: ExecSyncOptions = {
    stdio: ['ignore', process.stderr, 'inherit'],
  };
  
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, 'AggregatedWebsiteBucket', {
      // TODO: add mechanism to decide if dev or prod env, cause autoDelete + removalPolicy is dangerous to set for prod env
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    
    const originAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity');
    bucket.grantRead(originAccessIdentity);

    const distribution = new Distribution(this, `PlatformDistribution`, {
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    const srcDir = path.resolve(__dirname, '..', '..');
    this.isFileExistingOrError(`${srcDir}/cdk.context.json`, 'srcDir of CDK entrypoint not existing');

    const baseAppDir = path.join(srcDir, 'base', 'frontend');
    this.isFileExistingOrError(`${baseAppDir}/package.json`, 'baseAppDir not existing');

    const baseBundle = Source.asset(baseAppDir, {
      bundling: {
        command: ['sh', '-c', 'echo "Docker build not supported. Please install esbuild."'],
        image: DockerImage.fromRegistry('alpine'),
        local: {
          tryBundle(outputDir: string) {
            try {
              execSync('esbuild --version', FrontendStack.execOptions);
            } catch {
              return false;
            }
            execSync(`cd ${baseAppDir} && pwd && npm ci && npm run build:prod`, FrontendStack.execOptions);
            copySync(join(baseAppDir, 'build'), outputDir, {
              ...FrontendStack.execOptions,
              recursive: true,
            });
            return true;
          },
        },
      },
    });

    new BucketDeployment(this, 'DeployBaseApp', {
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      logRetention: RetentionDays.ONE_DAY,
      prune: false,
      sources: [baseBundle],
    });

    // everything below this isn't creating the assets per app :(
    
    const staticApp = {
      appName: "service-portal",
      buildCommand: "npm ci && npm run build:prod && rm -rf node_modules",
      siteFolder: "apps/service-portal/frontend",
      siteSubDomain: "sp",
      buildOutputFolder: "build"
    };

    const appDir = path.join(srcDir, staticApp.siteFolder);
    this.isFileExistingOrError(`${appDir}/package.json`, 'appDir not existing');
    
    // this bundling isn't even called - but the path to the app is correct, i verified it even by typing the generated commands in the terminal
    const appBundle = Source.asset(appDir, {
        bundling: {
          command: ['sh', '-c', 'echo "Docker build not supported. Please install esbuild."'],
          image: DockerImage.fromRegistry('alpine'),
          local: {
            tryBundle(outputDir: string) {
              try {
                execSync('esbuild --version', FrontendStack.execOptions);
              } catch {
                return false;
              }
              execSync(`cd ${appDir} && pwd && ${staticApp.buildCommand}`, FrontendStack.execOptions);
              copySync(join(appDir, staticApp.buildOutputFolder), outputDir, {
                ...FrontendStack.execOptions,
                recursive: true,
              });
              return true;
            },
          },
        },
      });

    // the provisioning of the distro takes place
    const appDistribution = new Distribution(this, `${staticApp.appName}Distribution`, {
        defaultBehavior: {
          origin: new S3Origin(bucket, { originAccessIdentity }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: `/${staticApp.buildOutputFolder}/index.html`,
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: `/${staticApp.buildOutputFolder}/index.html`,
          },
        ],
      });

      // the deployment doesn't run...  
      new BucketDeployment(this, `${staticApp.appName}BucketDeploy`, {
        destinationBucket: bucket,
        destinationKeyPrefix: staticApp.buildOutputFolder,
        distribution: appDistribution,
        // even when I tried to set this distroPath to staticApp.buildOutputFolder, this wasn't triggering
        distributionPaths: [`/*`],
        logRetention: RetentionDays.ONE_DAY,
        prune: false,
        sources: [appBundle],
      });  
  
    
  }
}
