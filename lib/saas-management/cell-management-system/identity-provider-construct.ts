import { aws_cognito, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IdentityDetails } from './identity-details';

export class IdentityProvider extends Construct {
  public readonly identityDetails: IdentityDetails;
  
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id);

    const systemAdminUserPool = new aws_cognito.UserPool(this, 'SystemAdminUserPool', {
      autoVerify: { email: true },
      accountRecovery: aws_cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
    });

    const writeAttributes = new aws_cognito.ClientAttributes()
      .withStandardAttributes({ email: true })
      
    const systemAdminUserPoolClient = new aws_cognito.UserPoolClient(this, 'SystemAdminUserPoolClient', {
      userPool: systemAdminUserPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        adminUserPassword: true,
        userSrp: true,
        custom: false,
      },
      writeAttributes: writeAttributes,
      oAuth: {
        scopes: [
          aws_cognito.OAuthScope.EMAIL,
          aws_cognito.OAuthScope.OPENID,
          aws_cognito.OAuthScope.PROFILE,
        ],
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
      },
    });    

    this.identityDetails = {
      name: 'Cognito',
      details: {
        userPoolId: systemAdminUserPool.userPoolId,
        appClientId: systemAdminUserPoolClient.userPoolClientId,
      },
    };
  }
}
