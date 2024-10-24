import { aws_cognito, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IdentityDetails } from '../interfaces/identity-details'

export class IdentityProvider extends Construct {
  public readonly identityDetails: IdentityDetails;
  
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id);

    const tenantUserPool = new aws_cognito.UserPool(this, 'TenantUserPool', {
      autoVerify: { email: true },
      accountRecovery: aws_cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      advancedSecurityMode: aws_cognito.AdvancedSecurityMode.ENFORCED,
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
        requireDigits: true
      },
      customAttributes: {
        tenantId: new aws_cognito.StringAttribute({ mutable: true }),
        role: new aws_cognito.StringAttribute({ mutable: true }),
      },
    });

    const writeAttributes = new aws_cognito.ClientAttributes()
      .withStandardAttributes({ email: true })
      
    const tenantUserPoolClient = new aws_cognito.UserPoolClient(this, 'TenantUserPoolClient', {
      userPool: tenantUserPool,
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
        userPoolId: tenantUserPool.userPoolId,
        appClientId: tenantUserPoolClient.userPoolClientId,
      },
    };
  }
}
